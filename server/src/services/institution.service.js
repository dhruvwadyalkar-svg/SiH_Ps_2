import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import Institution from '../models/Institution.js';
import { institutionStatuses } from '../utils/institution.validation.js';

export const serializeInstitution = (institution) => ({
  id: String(institution._id),
  name: institution.name,
  institutionCode: institution.institutionCode,
  contactEmail: institution.contactEmail,
  contactPhone: institution.contactPhone,
  address: institution.address,
  status: institution.status,
  createdAt: institution.createdAt,
  updatedAt: institution.updatedAt,
});

export class InstitutionServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const createSearchPattern = (search) => new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

export const getInstitutionForUser = async (institutionId) => {
  if (!institutionId) {
    throw new InstitutionServiceError(404, 'No institution is associated with this user.');
  }

  const institution = await Institution.findById(institutionId);
  if (!institution) {
    throw new InstitutionServiceError(404, 'Institution not found.');
  }

  return institution;
};

export const updateInstitutionProfile = async (institutionId, profile, actorId) => {
  const session = await mongoose.startSession();
  let updatedInstitution;

  try {
    await session.withTransaction(async () => {
      const institution = await Institution.findById(institutionId).session(session);
      if (!institution) {
        throw new InstitutionServiceError(404, 'Institution not found.');
      }

      const previousValues = Object.fromEntries(
        Object.keys(profile).map((field) => [field, institution[field]]),
      );
      Object.assign(institution, profile);
      await institution.save({ session });

      const changedFields = Object.keys(profile).filter(
        (field) => previousValues[field] !== institution[field],
      );
      if (changedFields.length > 0) {
        await new AuditLog({
          actor: actorId,
          action: 'institution_profile_updated',
          entityType: 'Institution',
          entityId: institution._id,
          metadata: { changedFields },
        }).save({ session });
      }

      updatedInstitution = institution;
    });
  } finally {
    await session.endSession();
  }

  return updatedInstitution;
};

export const listInstitutions = async ({ page, limit, search, status }) => {
  const filter = {};
  if (status) {
    filter.status = status;
  }
  if (search) {
    const pattern = createSearchPattern(search);
    filter.$or = [{ name: pattern }, { institutionCode: pattern }];
  }

  const [total, institutions] = await Promise.all([
    Institution.countDocuments(filter),
    Institution.find(filter)
      .select('name institutionCode contactEmail contactPhone address status createdAt updatedAt')
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
  ]);

  return {
    institutions: institutions.map(serializeInstitution),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

export const getInstitutionReviewDetails = async (institutionId) => {
  const institution = await Institution.findById(institutionId)
    .select('name institutionCode contactEmail contactPhone address status createdAt updatedAt');
  if (!institution) {
    throw new InstitutionServiceError(404, 'Institution not found.');
  }

  const auditRecords = await AuditLog.find({
    entityType: 'Institution',
    entityId: institution._id,
    action: 'institution_status_reviewed',
  })
    .select('actor metadata createdAt')
    .populate('actor', 'fullName role')
    .sort({ createdAt: -1, _id: -1 })
    .limit(20);

  const reviewHistory = auditRecords.map((record) => ({
    actor: record.actor
      ? { id: String(record.actor._id), fullName: record.actor.fullName, role: record.actor.role }
      : null,
    previousStatus: record.metadata.previousStatus,
    newStatus: record.metadata.newStatus,
    reason: record.metadata.reason,
    timestamp: record.createdAt,
  }));

  return { institution: serializeInstitution(institution), reviewHistory };
};

const canTransition = (from, to, role) => {
  const transitions = {
    pending: ['active', 'inactive'],
    active: role === 'aicte_admin' ? ['suspended'] : [],
    suspended: role === 'aicte_admin' ? ['active'] : [],
    inactive: [],
  };

  return institutionStatuses.includes(from) && transitions[from]?.includes(to) === true;
};

export const reviewInstitutionStatus = async (institutionId, { status, reason }, actor) => {
  const session = await mongoose.startSession();
  let reviewedInstitution;

  try {
    await session.withTransaction(async () => {
      const institution = await Institution.findById(institutionId).session(session);
      if (!institution) {
        throw new InstitutionServiceError(404, 'Institution not found.');
      }

      const previousStatus = institution.status;
      if (!canTransition(previousStatus, status, actor.role)) {
        throw new InstitutionServiceError(
          409,
          `The status transition from "${previousStatus}" to "${status}" is not allowed for this role.`,
        );
      }

      institution.status = status;
      await institution.save({ session });
      await new AuditLog({
        actor: actor._id,
        action: 'institution_status_reviewed',
        entityType: 'Institution',
        entityId: institution._id,
        metadata: { previousStatus, newStatus: status, reason },
      }).save({ session });

      reviewedInstitution = institution;
    });
  } finally {
    await session.endSession();
  }

  return reviewedInstitution;
};
