export const authorizeRoles =
  (...allowedRoles) =>
  (request, response, next) => {
    if (!request.user) {
      return response.status(401).json({ error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(request.user.role)) {
      return response.status(403).json({ error: 'You are not authorized to access this resource.' });
    }

    return next();
  };
