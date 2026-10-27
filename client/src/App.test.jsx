import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';

const institutionUser = {
  id: 'synthetic-institution-user',
  fullName: 'Synthetic Institution User',
  email: 'institution@example.test',
  role: 'institution_user',
  institution: { id: 'synthetic-institution', name: 'Synthetic Institution', institutionCode: 'SYN-01' },
};

const reviewerUser = {
  id: 'synthetic-reviewer',
  fullName: 'Synthetic Reviewer',
  email: 'reviewer@example.test',
  role: 'reviewer',
  institution: null,
};

const fdrRecord = {
  id: 'synthetic-fdr',
  fdrNumber: 'SYN-FDR-10',
  bankName: 'Synthetic Bank',
  branch: 'Demo Branch',
  amount: 250000,
  currency: 'INR',
  issueDate: '2026-01-01T00:00:00.000Z',
  maturityDate: '2027-01-01T00:00:00.000Z',
  workflowStatus: 'submitted',
  financialStatus: 'active',
  documentMetadata: { fileName: 'synthetic.pdf' },
};

const reviewDetail = (status = 'submitted') => ({
  institution: { id: 'synthetic-institution', name: 'Synthetic Institution', institutionCode: 'SYN-01' },
  fdr: {
    ...fdrRecord,
    workflowStatus: status,
    institutionSubmitted: {
      fdrNumber: fdrRecord.fdrNumber,
      bankName: fdrRecord.bankName,
      branch: fdrRecord.branch,
      amount: fdrRecord.amount,
      currency: fdrRecord.currency,
      issueDate: fdrRecord.issueDate,
      maturityDate: fdrRecord.maturityDate,
    },
    document: { fileName: 'synthetic.pdf' },
    ocr: { status: 'not_started' },
    forensic: null,
    reviewerConfirmedDetails: {},
    reviewHistory: [],
    replacements: [],
    replacementOf: null,
    releaseRequests: [],
  },
});

const makeResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let apiHandler;
let fetchMock;

const loginResponse = (user) => ({
  accessToken: 'synthetic-token-not-persisted',
  user,
});

const dashboardSummary = {
  totalFdrs: 1,
  byWorkflowStatus: { submitted: 1 },
  approachingMaturity: 1,
  maturedAwaitingAction: 0,
  pendingReview: 1,
  correctionRequests: 0,
  renewalReplacementWorkload: 0,
  activeReleaseRequests: 0,
  unreadNotifications: 2,
  period: { asOfDate: '2026-10-28' },
};

const renderApp = () => render(<MemoryRouter initialEntries={['/login']}><App /></MemoryRouter>);

const signIn = async (user) => {
  const actor = userEvent.setup();
  await actor.type(screen.getByLabelText('Email address'), user.email);
  await actor.type(screen.getByLabelText('Password'), 'synthetic-test-password');
  await actor.click(screen.getByRole('button', { name: 'Sign in securely' }));
  await screen.findByRole('heading', { name: 'Good day' });
  return actor;
};

describe('Phase 10 frontend API integration', () => {
  beforeEach(() => {
    localStorage.clear();
    apiHandler = async (url) => {
      if (url.pathname.endsWith('/notifications/unread-count')) return { body: { unreadCount: 2 } };
      if (url.pathname.endsWith('/dashboard/summary')) return { body: dashboardSummary };
      return { status: 404, body: { error: 'Synthetic API route is not configured.' } };
    };
    fetchMock = vi.fn(async (input, options = {}) => {
      const url = new URL(String(input));
      const response = await apiHandler(url, options);
      return makeResponse(response.body, response.status || 200);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the login token in memory and shows institution-scoped navigation', async () => {
    apiHandler = async (url) => {
      if (url.pathname.endsWith('/auth/login')) return { body: loginResponse(institutionUser) };
      if (url.pathname.endsWith('/notifications/unread-count')) return { body: { unreadCount: 2 } };
      if (url.pathname.endsWith('/dashboard/summary')) return { body: dashboardSummary };
      return { status: 404, body: { error: 'Not found.' } };
    };

    renderApp();
    await signIn(institutionUser);

    expect(document.querySelector('.topbar-context')?.textContent).toContain('Synthetic Institution');
    expect(screen.getByRole('link', { name: /FDR register/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /FDR reports/ })).toBeNull();
    expect(await screen.findByText('Current instruments')).toBeTruthy();
    expect(localStorage.length).toBe(0);
    expect(fetchMock.mock.calls.every(([, options]) => options.credentials === 'omit')).toBe(true);
  });

  it('uploads a synthetic FDR through the existing API without sending ownership fields', async () => {
    let submittedBody;
    apiHandler = async (url, options) => {
      if (url.pathname.endsWith('/auth/login')) return { body: loginResponse(institutionUser) };
      if (url.pathname.endsWith('/notifications/unread-count')) return { body: { unreadCount: 0 } };
      if (url.pathname.endsWith('/dashboard/summary')) return { body: dashboardSummary };
      if (url.pathname.endsWith('/fdrs') && options.method === 'POST') {
        submittedBody = options.body;
        return { status: 201, body: { fdr: fdrRecord } };
      }
      if (url.pathname.endsWith('/fdrs/synthetic-fdr')) return { body: { fdr: fdrRecord } };
      if (url.pathname.endsWith('/fdrs/synthetic-fdr/extraction')) return { body: { status: 'not_started' } };
      if (url.pathname.endsWith('/fdrs/synthetic-fdr/forensics')) return { status: 404, body: { error: 'No forensic analysis is available.' } };
      return { status: 404, body: { error: 'Not found.' } };
    };

    renderApp();
    const actor = await signIn(institutionUser);
    await actor.click(screen.getByRole('link', { name: /Add FDR/ }));
    await actor.type(screen.getByLabelText('FDR number'), 'SYN-FDR-10');
    await actor.type(screen.getByLabelText('Issuing bank'), 'Synthetic Bank');
    await actor.type(screen.getByLabelText('Branch'), 'Demo Branch');
    await actor.type(screen.getByLabelText('Deposit amount'), '250000');
    await actor.clear(screen.getByLabelText('Currency'));
    await actor.type(screen.getByLabelText('Currency'), 'INR');
    fireEvent.change(screen.getByLabelText('Issue date'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Maturity date'), { target: { value: '2027-01-01' } });
    const file = new File(['synthetic PDF fixture'], 'synthetic.pdf', { type: 'application/pdf' });
    await actor.upload(screen.getByLabelText(/Supporting document/), file);
    fireEvent.submit(screen.getByRole('button', { name: 'Submit FDR' }).closest('form'));

    await waitFor(() => expect(submittedBody).toBeInstanceOf(FormData));
    expect(await screen.findByRole('heading', { name: 'SYN-FDR-10' })).toBeTruthy();
    expect(submittedBody).toBeInstanceOf(FormData);
    expect(submittedBody.get('document').name).toBe('synthetic.pdf');
    expect(submittedBody.get('institution')).toBeNull();
    expect(screen.getByText(/do not verify bank authenticity/)).toBeTruthy();
  });

  it('lets an official inspect and decide a synthetic review record', async () => {
    let decisions = 0;
    apiHandler = async (url, options) => {
      if (url.pathname.endsWith('/auth/login')) return { body: loginResponse(reviewerUser) };
      if (url.pathname.endsWith('/notifications/unread-count')) return { body: { unreadCount: 0 } };
      if (url.pathname.endsWith('/admin/dashboard/summary')) return { body: { ...dashboardSummary, totalInstitutions: 1 } };
      if (url.pathname.endsWith('/admin/fdrs/review-queue')) {
        return { body: { records: [{ ...fdrRecord, institution: { name: 'Synthetic Institution', institutionCode: 'SYN-01' }, submittedAt: '2026-10-01' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } } };
      }
      if (url.pathname.endsWith('/admin/fdrs/synthetic-fdr/review') && options.method === 'POST') {
        decisions += 1;
        return { body: { decision: { decision: 'complete_review' } } };
      }
      if (url.pathname.endsWith('/admin/fdrs/synthetic-fdr/review')) {
        return { body: reviewDetail(decisions ? 'review_completed' : 'submitted') };
      }
      return { status: 404, body: { error: 'Not found.' } };
    };

    renderApp();
    const actor = await signIn(reviewerUser);
    expect(screen.getByRole('link', { name: /FDR reports/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Institution profile/ })).toBeNull();
    await actor.click(screen.getByRole('link', { name: /Review queue/ }));
    await screen.findByRole('heading', { name: 'FDR review queue' });
    await actor.click(screen.getByRole('link', { name: /Review →/ }));
    await screen.findByRole('heading', { name: 'SYN-FDR-10' });
    await actor.type(screen.getByLabelText('Reason / observation'), 'Synthetic review completed after inspection.');
    await actor.click(screen.getByRole('button', { name: 'Complete review' }));

    await waitFor(() => expect(decisions).toBe(1));
    expect(await screen.findByText('Review Completed')).toBeTruthy();
    expect(screen.getByText(/does not confirm bank authenticity/)).toBeTruthy();
  });
});
