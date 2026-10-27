import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { apiRequest, saveAuthenticatedDownload, setUnauthorizedHandler } from './api.js';

const AuthContext = createContext(null);
const institutionRoles = ['institution_admin', 'institution_user'];
const officialRoles = ['aicte_admin', 'reviewer'];

const useAuth = () => useContext(AuthContext);
const isOfficial = (user) => officialRoles.includes(user?.role);
const isInstitutionUser = (user) => institutionRoles.includes(user?.role);

function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const logout = useCallback(() => setSession(null), []);
  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  const value = useMemo(() => ({
    ...session,
    login: (result) => setSession({ token: result.accessToken, user: result.user }),
    logout,
    request: (path, options = {}) => apiRequest(path, { token: session?.token, ...options }),
  }), [session, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegistrationPage />} />
        <Route path="/*" element={<RequireAuth><PortalLayout /></RequireAuth>}>
          <Route index element={<DashboardPage />} />
          <Route path="fdrs" element={<FdrListPage />} />
          <Route path="fdrs/new" element={<NewFdrPage />} />
          <Route path="fdrs/:id" element={<FdrDetailPage />} />
          <Route path="institution" element={<InstitutionProfilePage />} />
          <Route path="admin/review" element={<ReviewQueuePage />} />
          <Route path="admin/review/:id" element={<ReviewDetailPage />} />
          <Route path="admin/institutions" element={<InstitutionAdminPage />} />
          <Route path="admin/releases" element={<ReleaseQueuePage />} />
          <Route path="admin/reports" element={<ReportsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

function RequireAuth({ children, roles }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await apiRequest('/auth/login', { method: 'POST', body: { email, password } });
      login(result);
      navigate(location.state?.from || '/', { replace: true });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame eyebrow="Secure access" title="Welcome back" subtitle="Sign in to manage institution deposits, review submissions, and track actions.">
      <form className="form-stack" onSubmit={submit}>
        <Field label="Email address" type="email" autoComplete="email" value={email} onChange={setEmail} required />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} required />
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
      </form>
      <p className="auth-footnote">Institution registration is available for institutions. Administrator accounts are provisioned securely by an authorized operator.</p>
      <LinkButton to="/register" variant="subtle">Register an institution</LinkButton>
    </AuthFrame>
  );
}

function RegistrationPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', institutionCode: '', contactEmail: '', contactPhone: '', address: '', fullName: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await apiRequest('/auth/register-institution', {
        method: 'POST',
        body: {
          institution: {
            name: form.name,
            institutionCode: form.institutionCode,
            contactEmail: form.contactEmail,
            contactPhone: form.contactPhone,
            address: form.address,
          },
          user: { fullName: form.fullName, email: form.email, password: form.password },
        },
      });
      setDone(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame eyebrow="Institution onboarding" title="Register your institution" subtitle="The first account is assigned the institution-user role. Approval remains a separate official review.">
      {done ? (
        <div className="form-stack">
          <Notice tone="success">Registration submitted. Your institution is pending official review.</Notice>
          <button className="button button-primary" onClick={() => navigate('/login')}>Return to sign in</button>
        </div>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <h3 className="form-section-title">Institution profile</h3>
          <div className="form-grid">
            <Field label="Institution name" value={form.name} onChange={set('name')} required minLength={2} maxLength={150} />
            <Field label="Institution code" value={form.institutionCode} onChange={set('institutionCode')} required maxLength={50} />
            <Field label="Contact email" type="email" value={form.contactEmail} onChange={set('contactEmail')} required />
            <Field label="Contact phone" value={form.contactPhone} onChange={set('contactPhone')} required />
            <Field className="field-span" label="Address" value={form.address} onChange={set('address')} required maxLength={500} />
          </div>
          <h3 className="form-section-title">Primary user</h3>
          <div className="form-grid">
            <Field label="Full name" value={form.fullName} onChange={set('fullName')} required />
            <Field label="Email" type="email" value={form.email} onChange={set('email')} required />
            <Field className="field-span" label="Password (at least 12 characters)" type="password" value={form.password} onChange={set('password')} required minLength={12} />
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Submitting…' : 'Submit registration'}</button>
          <LinkButton to="/login" variant="subtle">Back to sign in</LinkButton>
        </form>
      )}
    </AuthFrame>
  );
}

function AuthFrame({ eyebrow, title, subtitle, children }) {
  return (
    <main className="auth-page">
      <div className="auth-brand"><BrandMark /><span>DEPOSIT REGISTER</span></div>
      <section className="auth-card">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        <div className="auth-content">{children}</div>
      </section>
      <footer className="auth-footer">AICTE Security Deposit / FDR Management Portal <span>·</span> Prototype</footer>
    </main>
  );
}

function PortalLayout() {
  const { user, logout, request } = useAuth();
  const [unread, setUnread] = useState(0);
  const [unreadError, setUnreadError] = useState('');
  useEffect(() => {
    request('/notifications/unread-count')
      .then((data) => { setUnread(data.unreadCount); setUnreadError(''); })
      .catch((requestError) => setUnreadError(requestError.message));
  }, [request]);
  const institutionItems = [
    { to: '/', label: 'Overview', icon: '◫' },
    { to: '/fdrs', label: 'FDR register', icon: '▤' },
    { to: '/institution', label: 'Institution profile', icon: '⌂' },
    { to: '/notifications', label: 'Notifications', icon: '◉', count: unread },
  ];
  const officialItems = [
    { to: '/', label: 'Overview', icon: '◫' },
    { to: '/admin/review', label: 'Review queue', icon: '▤' },
    { to: '/admin/institutions', label: 'Institutions', icon: '⌂' },
    { to: '/admin/releases', label: 'Release requests', icon: '↗' },
    { to: '/admin/reports', label: 'FDR reports', icon: '▥' },
    { to: '/notifications', label: 'Notifications', icon: '◉', count: unread },
  ];
  const items = isOfficial(user) ? officialItems : institutionItems;
  const location = useLocation();
  return (
    <div className="portal-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><BrandMark /><span><b>DEPOSIT</b><small>REGISTER</small></span></div>
        <div className="side-label">WORKSPACE</div>
        <nav className="side-nav">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
              {!!item.count && <span className="nav-count">{item.count}</span>}
            </NavLink>
          ))}
          {isOfficial(user) && <div className="side-label side-label-spaced">ADMINISTRATION</div>}
          {isOfficial(user) && <NavLink to="/admin/review" className={`nav-item ${location.pathname.startsWith('/admin/review') ? 'active' : ''}`}><span className="nav-icon">✓</span><span>Review workbench</span></NavLink>}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><span className="security-dot" /> Protected workspace</div>
          <button className="user-chip" onClick={logout} title="Sign out">
            <span className="avatar">{initials(user.fullName)}</span>
            <span className="user-chip-text"><b>{user.fullName}</b><small>{roleLabel(user.role)}</small></span>
            <span className="logout-icon">↗</span>
          </button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="mobile-brand"><BrandMark /><b>DEPOSIT REGISTER</b></div>
          <div className="topbar-context"><span className="context-dot" />{user.institution?.name || 'AICTE Administration'}<span className="separator">/</span>{roleLabel(user.role)}</div>
          <LinkButton to="/notifications" variant="icon" aria-label="Notifications">◉{unread > 0 && <span className="notification-dot" />}</LinkButton>
        </header>
        <div className="content-area">
          {unreadError && <Notice tone="danger">{`Notification count unavailable: ${unreadError}`}</Notice>}
          <Routes>
            <Route index element={<DashboardPage />} />
            <Route path="fdrs" element={<FdrListPage />} />
            <Route path="fdrs/new" element={<RoleGuard roles={institutionRoles}><NewFdrPage /></RoleGuard>} />
            <Route path="fdrs/:id" element={<FdrDetailPage />} />
            <Route path="institution" element={<RoleGuard roles={institutionRoles}><InstitutionProfilePage /></RoleGuard>} />
            <Route path="admin/review" element={<RoleGuard roles={officialRoles}><ReviewQueuePage /></RoleGuard>} />
            <Route path="admin/review/:id" element={<RoleGuard roles={officialRoles}><ReviewDetailPage /></RoleGuard>} />
            <Route path="admin/institutions" element={<RoleGuard roles={officialRoles}><InstitutionAdminPage /></RoleGuard>} />
            <Route path="admin/releases" element={<RoleGuard roles={officialRoles}><ReleaseQueuePage /></RoleGuard>} />
            <Route path="admin/reports" element={<RoleGuard roles={officialRoles}><ReportsPage /></RoleGuard>} />
            <Route path="notifications" element={<NotificationsPage onUnreadChange={setUnread} />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function RoleGuard({ roles, children }) {
  const { user } = useAuth();
  return roles.includes(user.role) ? children : <Notice tone="danger">Your account is not permitted to access this page.</Notice>;
}

function DashboardPage() {
  const { user, request } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    setBusy(true);
    request(isOfficial(user) ? '/admin/dashboard/summary' : '/dashboard/summary')
      .then(setData)
      .catch((requestError) => setError(requestError.message))
      .finally(() => setBusy(false));
  }, [request, user]);

  return (
    <PageHeader eyebrow={isOfficial(user) ? 'OFFICIAL OVERVIEW' : 'INSTITUTION OVERVIEW'} title="Good day" subtitle={isOfficial(user) ? 'A clear view of review activity and instruments requiring attention.' : 'Your institution’s deposit register, maturity timeline, and outstanding actions.'} action={isInstitutionUser(user) ? <LinkButton to="/fdrs/new" variant="primary">＋ Add FDR</LinkButton> : null}>
      {error && <Notice tone="danger">{error}</Notice>}
      {busy ? <LoadingState label="Loading your dashboard…" /> : data ? (
        <>
          <div className="metric-grid">
            {isOfficial(user) && <MetricCard label="Institutions" value={data.totalInstitutions ?? '—'} icon="⌂" tone="olive" />}
            <MetricCard label="Current instruments" value={data.totalFdrs ?? 0} icon="▤" tone="olive" />
            <MetricCard label="Approaching maturity" value={data.approachingMaturity ?? 0} icon="◷" tone="amber" hint="Next 30 days" />
            <MetricCard label="Matured · action needed" value={data.maturedAwaitingAction ?? 0} icon="!" tone="clay" />
            <MetricCard label="Pending review" value={data.pendingReview ?? 0} icon="⌕" tone="sand" />
            <MetricCard label="Unread notifications" value={data.unreadNotifications ?? 0} icon="◉" tone="olive" />
          </div>
          <section className="panel dashboard-detail">
            <div className="panel-heading"><div><p className="eyebrow">REGISTER HEALTH</p><h2>Workflow snapshot</h2></div><span className="muted small">As of {formatDate(data.period?.asOfDate)}</span></div>
            <StatusBars values={data.byWorkflowStatus || {}} />
            <div className="dashboard-foot-grid">
              <div><span className="detail-label">Correction requested</span><b>{data.correctionRequests ?? 0}</b></div>
              <div><span className="detail-label">Replacement workload</span><b>{data.renewalReplacementWorkload ?? 0}</b></div>
              <div><span className="detail-label">Active release requests</span><b>{data.activeReleaseRequests ?? 0}</b></div>
            </div>
          </section>
          <Notice tone="info">Dashboard counts are operational summaries only. Maturity or administrative review does not confirm bank-side authenticity or release funds.</Notice>
        </>
      ) : <EmptyState title="Dashboard unavailable" detail="Refresh the page or check your connection." />}
    </PageHeader>
  );
}

function FdrListPage() {
  const { user, request } = useAuth();
  const [query, setQuery] = useState({ page: 1, limit: 20, search: '', workflowStatus: '', fromDate: '', toDate: '' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true); setError('');
    const params = new URLSearchParams({ page: String(query.page), limit: String(query.limit) });
    if (query.search.trim()) params.set('search', query.search.trim());
    if (query.workflowStatus) params.set('workflowStatus', query.workflowStatus);
    if (query.fromDate) params.set('fromDate', query.fromDate);
    if (query.toDate) params.set('toDate', query.toDate);
    try {
      setResult(isOfficial(user)
        ? await request(`/admin/fdrs/review-queue?${params}`)
        : await request(`/fdrs?${params}`));
    }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }, [request, query, user]);
  useEffect(() => { load(); }, [load]);
  const records = result?.fdrs || result?.records || [];
  return (
    <PageHeader eyebrow="INSTRUMENT REGISTER" title="FDR records" subtitle={isOfficial(user) ? 'Browse submitted instruments across institutions.' : 'Manage your institution’s submitted deposits and linked renewals.'} action={isInstitutionUser(user) && <LinkButton to="/fdrs/new" variant="primary">＋ Add FDR</LinkButton>}>
      <section className="panel">
        <div className="filters-row fdr-filter-row">
          <SearchInput value={query.search} onChange={(value) => setQuery((current) => ({ ...current, search: value, page: 1 }))} onSearch={load} placeholder="Search FDR number or bank" />
          <SelectField ariaLabel="Workflow status" value={query.workflowStatus} onChange={(value) => setQuery((current) => ({ ...current, workflowStatus: value, page: 1 }))} options={workflowOptions} includeAll="All workflow statuses" />
          <label className="date-filter">Maturity from<input type="date" value={query.fromDate} onChange={(event) => setQuery((current) => ({ ...current, fromDate: event.target.value, page: 1 }))} /></label>
          <label className="date-filter">Maturity to<input type="date" value={query.toDate} onChange={(event) => setQuery((current) => ({ ...current, toDate: event.target.value, page: 1 }))} /></label>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {busy ? <LoadingState label="Loading FDR records…" /> : records.length ? (
          <>
            <div className="table-scroll"><table><thead><tr><th>FDR number</th><th>Bank / branch</th>{isOfficial(user) && <th>Institution</th>}<th>Amount</th><th>Maturity</th><th>Workflow</th><th /></tr></thead>
              <tbody>{records.map((record) => <tr key={record.id}>
                <td><LinkButton to={`/fdrs/${record.id}`} variant="text">{record.fdrNumber}</LinkButton><small className="table-sub">{record.currency}</small></td>
                <td>{record.bankName}<small className="table-sub">{record.branch}</small></td>
                {isOfficial(user) && <td>{record.institution?.name || '—'}<small className="table-sub">{record.institution?.institutionCode}</small></td>}
                <td>{formatMoney(record.amount, record.currency)}</td>
                <td>{formatDate(record.maturityDate)}</td>
                <td><StatusPill value={record.workflowStatus} /></td>
                <td><LinkButton to={`/fdrs/${record.id}`} variant="text">View →</LinkButton></td>
              </tr>)}</tbody>
            </table></div>
            <Pagination value={result.pagination} onChange={(page) => setQuery((current) => ({ ...current, page }))} />
          </>
        ) : <EmptyState title="No FDR records found" detail={query.search || query.workflowStatus ? 'Try adjusting your search or filters.' : 'Create the first FDR record for this institution.'} action={isInstitutionUser(user) && <LinkButton to="/fdrs/new" variant="secondary">Add first FDR</LinkButton>} />}
      </section>
    </PageHeader>
  );
}

const initialFdrForm = { fdrNumber: '', bankName: '', branch: '', amount: '', currency: 'INR', issueDate: '', maturityDate: '' };
const allowedTypes = '.pdf,.jpg,.jpeg,.png';

function NewFdrPage() {
  const { request } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState(initialFdrForm);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!file) return setError('Choose a supporting PDF, JPEG, or PNG document.');
    setBusy(true);
    const body = new FormData();
    Object.entries(form).forEach(([key, value]) => body.append(key, value));
    body.append('document', file);
    try {
      const result = await request('/fdrs', { method: 'POST', body, timeout: 60_000 });
      navigate(`/fdrs/${result.fdr.id}`);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  return (
    <PageHeader eyebrow="NEW SUBMISSION" title="Register an FDR" subtitle="Enter instrument details exactly as shown. The server assigns institution ownership and checks the uploaded document.">
      <form className="panel form-stack form-panel" onSubmit={submit}>
        <div className="form-grid">
          <Field label="FDR number" value={form.fdrNumber} onChange={set('fdrNumber')} required maxLength={100} />
          <Field label="Issuing bank" value={form.bankName} onChange={set('bankName')} required maxLength={200} />
          <Field label="Branch" value={form.branch} onChange={set('branch')} required maxLength={200} />
          <Field label="Deposit amount" type="number" min="0.01" step="0.01" value={form.amount} onChange={set('amount')} required />
          <Field label="Currency" value={form.currency} onChange={set('currency')} required maxLength={3} />
          <Field label="Issue date" type="date" value={form.issueDate} onChange={set('issueDate')} required />
          <Field label="Maturity date" type="date" value={form.maturityDate} onChange={set('maturityDate')} required />
          <FileField label="Supporting document" accept={allowedTypes} onChange={(value) => setFile(value)} required help="PDF, JPEG or PNG · maximum 10 MB" />
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="form-actions"><LinkButton to="/fdrs" variant="secondary">Cancel</LinkButton><button className="button button-primary" disabled={busy}>{busy ? 'Uploading securely…' : 'Submit FDR'}</button></div>
      </form>
    </PageHeader>
  );
}

function FdrDetailPage() {
  const { id } = useParams();
  const { user, request, token } = useAuth();
  const navigate = useNavigate();
  const [fdr, setFdr] = useState(null);
  const [ocr, setOcr] = useState(null);
  const [forensic, setForensic] = useState(null);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [edit, setEdit] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [reason, setReason] = useState('');
  const [renewalForm, setRenewalForm] = useState(initialFdrForm);
  const [renewalFile, setRenewalFile] = useState(null);
  const [releaseReason, setReleaseReason] = useState('');
  const [showRenewal, setShowRenewal] = useState(false);
  const [showRelease, setShowRelease] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [{ fdr: record }, extraction] = await Promise.all([
        request(`/fdrs/${id}`),
        request(`/fdrs/${id}/extraction`).catch((requestError) => {
          if (requestError.status === 404) return null;
          throw requestError;
        }),
      ]);
      setFdr(record);
      setEditForm({
        fdrNumber: record.fdrNumber,
        bankName: record.bankName,
        branch: record.branch,
        amount: record.amount,
        currency: record.currency,
        issueDate: String(record.issueDate).slice(0, 10),
        maturityDate: String(record.maturityDate).slice(0, 10),
      });
      if (extraction) setOcr(extraction);
      const analysis = await request(`/fdrs/${id}/forensics`).catch((requestError) => {
        if (requestError.status === 404) return null;
        throw requestError;
      });
      if (analysis?.analysis) setForensic(analysis.analysis);
    } catch (requestError) { setError(requestError.message); }
  }, [id, request]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!ocr || !['submitting', 'queued', 'processing', 'pending'].includes(ocr.status)) return undefined;
    const timer = window.setInterval(async () => {
      try { setOcr(await request(`/fdrs/${id}/extraction`)); }
      catch (requestError) { setError(requestError.message); }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [ocr?.status, id, request]);

  const runAction = async (key, operation) => {
    setBusyAction(key); setError('');
    try { await operation(); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusyAction(''); }
  };
  if (!fdr && error) return <PageHeader eyebrow="FDR RECORD" title="Unable to open record"><Notice tone="danger">{error}</Notice><LinkButton to="/fdrs" variant="secondary">Back to register</LinkButton></PageHeader>;
  if (!fdr) return <LoadingState label="Loading FDR details…" />;
  const setEditField = (key) => (value) => setEditForm((current) => ({ ...current, [key]: value }));
  const startExtraction = () => runAction('ocr', async () => {
    const result = await request(`/fdrs/${id}/extract`, { method: 'POST' });
    setOcr(result);
  });
  const runForensics = () => runAction('forensics', async () => {
    const result = await request(`/fdrs/${id}/forensics`, { method: 'POST', timeout: 60_000 });
    setForensic(result.analysis);
  });
  const updateFdr = () => runAction('update', async () => {
    const result = await request(`/fdrs/${id}`, { method: 'PATCH', body: { ...editForm, workflowStatus: fdr.workflowStatus === 'correction_requested' ? 'submitted' : undefined } });
    setFdr(result.fdr); setEdit(false); await load();
  });
  const submitRenewal = async (event) => {
    event.preventDefault();
    if (!renewalFile) return setError('Choose a replacement document.');
    await runAction('renewal', async () => {
      const formData = new FormData();
      Object.entries(renewalForm).forEach(([key, value]) => formData.append(key, value));
      formData.append('document', renewalFile);
      const result = await request(`/fdrs/${id}/renewal`, { method: 'POST', body: formData, timeout: 60_000 });
      setShowRenewal(false);
      navigate(`/fdrs/${result.replacement.id}`);
    });
  };
  const submitRelease = (event) => {
    event.preventDefault();
    runAction('release', async () => {
      await request(`/fdrs/${id}/release-requests`, { method: 'POST', body: { reason: releaseReason } });
      setReleaseReason(''); setShowRelease(false);
    });
  };
  const compareValues = ocr?.comparisons || {};

  return (
    <PageHeader eyebrow="INSTRUMENT RECORD" title={fdr.fdrNumber} subtitle={`${fdr.bankName} · ${fdr.branch}`} action={<><StatusPill value={fdr.workflowStatus} /><StatusPill value={fdr.financialStatus} /></>}>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="detail-grid">
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">SUBMITTED DETAILS</p><h2>Instrument profile</h2></div>{isInstitutionUser(user) && <button className="button button-secondary button-small" onClick={() => setEdit(!edit)}>{edit ? 'Cancel edit' : 'Edit details'}</button>}</div>
          {edit ? (
            <div className="form-grid compact-grid">
              <Field label="FDR number" value={editForm.fdrNumber} onChange={setEditField('fdrNumber')} />
              <Field label="Bank" value={editForm.bankName} onChange={setEditField('bankName')} />
              <Field label="Branch" value={editForm.branch} onChange={setEditField('branch')} />
              <Field label="Amount" type="number" min="0.01" value={editForm.amount} onChange={setEditField('amount')} />
              <Field label="Currency" value={editForm.currency} onChange={setEditField('currency')} />
              <Field label="Issue date" type="date" value={editForm.issueDate} onChange={setEditField('issueDate')} />
              <Field label="Maturity date" type="date" value={editForm.maturityDate} onChange={setEditField('maturityDate')} />
              <div className="field-span form-actions"><button className="button button-primary" onClick={updateFdr} disabled={!!busyAction}>{busyAction === 'update' ? 'Saving…' : 'Save updates'}</button></div>
            </div>
          ) : <DetailGrid rows={[
            ['Deposit amount', formatMoney(fdr.amount, fdr.currency)],
            ['Issue date', formatDate(fdr.issueDate)],
            ['Maturity date', formatDate(fdr.maturityDate)],
            ['Financial status', fdr.financialStatus],
            ['Submitted', formatDate(fdr.createdAt)],
            ['Replacement of', fdr.replacesFdr || '—'],
            ['Document', fdr.documentMetadata?.fileName || 'No document'],
          ]} />}
          {fdr.documentMetadata?.fileName && <button className="button button-secondary" onClick={() => runAction('download', () => saveAuthenticatedDownload({ path: `/fdrs/${id}/document`, token, filename: fdr.documentMetadata.fileName }))}>↓ Download supporting document</button>}
          {isInstitutionUser(user) && <div className="button-row top-gap"><button className="button button-secondary" onClick={() => setShowRenewal(!showRenewal)}>＋ Submit replacement</button><button className="button button-secondary" onClick={() => setShowRelease(!showRelease)}>Request release / refund</button></div>}
        </section>
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">DOCUMENT REVIEW</p><h2>OCR extraction</h2></div><span className="muted small">{ocr?.status || 'Not requested'}</span></div>
          <p className="muted small">Extracted fields are presented separately from submitted details.</p>
          <div className="button-row"><button className="button button-secondary button-small" onClick={startExtraction} disabled={!!busyAction || ['completed', 'partially_completed', 'queued', 'processing', 'submitting'].includes(ocr?.status)}>{busyAction === 'ocr' ? 'Requesting…' : 'Request OCR'}</button><span className="muted small">{ocr?.status === 'processing' || ocr?.status === 'queued' ? 'Checking status every 5 seconds' : ocr?.errorCode || ''}</span></div>
          {ocr?.extractedFields && <ComparisonTable submitted={fdr} extracted={ocr.extractedFields} comparisons={compareValues} />}
          <div className="divider" />
          <div className="panel-heading"><div><p className="eyebrow">PRELIMINARY CHECKS</p><h2>Document forensics</h2></div><span className="muted small">{forensic?.status || 'Not analyzed'}</span></div>
          <button className="button button-secondary button-small" onClick={runForensics} disabled={!!busyAction}>{busyAction === 'forensics' ? 'Analyzing…' : 'Run local analysis'}</button>
          {forensic ? <ForensicPanel analysis={forensic} /> : <p className="muted small top-gap">No analysis report is available yet.</p>}
        </section>
      </div>
      {showRenewal && <section className="panel form-panel top-gap"><div className="panel-heading"><div><p className="eyebrow">LINKED SUBMISSION</p><h2>Submit replacement FDR</h2></div><button className="button button-quiet" onClick={() => setShowRenewal(false)}>Close</button></div>
        <form className="form-stack" onSubmit={submitRenewal}><div className="form-grid">{['fdrNumber', 'bankName', 'branch', 'amount', 'currency', 'issueDate', 'maturityDate'].map((key) => <Field key={key} label={labelize(key)} type={key.toLowerCase().includes('date') ? 'date' : key === 'amount' ? 'number' : 'text'} value={renewalForm[key]} onChange={(value) => setRenewalForm((current) => ({ ...current, [key]: value }))} required />)}<FileField label="Replacement document" accept={allowedTypes} onChange={setRenewalFile} required /></div><button className="button button-primary" disabled={!!busyAction}>{busyAction === 'renewal' ? 'Uploading…' : 'Submit linked replacement'}</button></form>
      </section>}
      {showRelease && <section className="panel form-panel top-gap"><h2>Release / refund request</h2><form className="form-stack" onSubmit={submitRelease}><TextArea label="Reason for request" value={releaseReason} onChange={setReleaseReason} required minLength={5} maxLength={2000} /><div className="form-actions"><button className="button button-secondary" type="button" onClick={() => setShowRelease(false)}>Cancel</button><button className="button button-primary" disabled={!!busyAction}>{busyAction === 'release' ? 'Submitting…' : 'Submit request'}</button></div></form></section>}
      <Notice tone="info">OCR comparisons and preliminary forensic checks are review aids only. They do not verify bank authenticity, guarantee genuineness, or trigger approval or release.</Notice>
    </PageHeader>
  );
}

function ComparisonTable({ submitted, extracted, comparisons }) {
  const fields = [['FDR number', 'fdrNumber'], ['Bank', 'bankName'], ['Branch', 'branch'], ['Amount', 'amount'], ['Currency', 'currency'], ['Issue date', 'issueDate'], ['Maturity date', 'maturityDate']];
  return <div className="table-scroll top-gap"><table className="comparison-table"><thead><tr><th>Field</th><th>Submitted</th><th>OCR extracted</th><th>Comparison</th></tr></thead><tbody>{fields.map(([label, key]) => {
    const extractionKey = key === 'fdrNumber' ? 'fdr_number' : key === 'bankName' ? 'bank_name' : key === 'issueDate' ? 'issue_date' : key === 'maturityDate' ? 'maturity_date' : key;
    return <tr key={key}><td>{label}</td><td>{String(submitted[key] ?? '—')}</td><td>{String(extracted[extractionKey] ?? '—')}</td><td><StatusPill value={comparisons[key]?.status || 'not_comparable'} /></td></tr>;
  })}</tbody></table></div>;
}

function ForensicPanel({ analysis }) {
  return <div className="forensic-panel top-gap">
    {analysis.findings?.length ? analysis.findings.map((item, index) => <div className="finding" key={`${item.code}-${index}`}><div><StatusPill value={item.severity} /><b>{labelize(item.code)}</b></div><p>{item.explanation}</p><small>{item.conclusive ? 'Conclusive for this specific check' : 'Heuristic / inconclusive'}</small></div>) : <Notice tone="success">No signals detected by these limited checks. This is not a determination of authenticity.</Notice>}
    {analysis.limitations?.length > 0 && <div className="limitations"><b>Limitations</b><ul>{analysis.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>}
  </div>;
}

function ReviewQueuePage() {
  const { request } = useAuth();
  const [filters, setFilters] = useState({ page: 1, limit: 20, search: '', workflowStatus: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    const params = new URLSearchParams({ page: filters.page, limit: filters.limit });
    if (filters.search) params.set('search', filters.search);
    if (filters.workflowStatus) params.set('workflowStatus', filters.workflowStatus);
    try { setData(await request(`/admin/fdrs/review-queue?${params}`)); }
    catch (requestError) { setError(requestError.message); }
  }, [request, filters]);
  useEffect(() => { load(); }, [load]);
  return <PageHeader eyebrow="OFFICIAL WORKBENCH" title="FDR review queue" subtitle="Review submissions, supporting documents, analysis results, and prior decisions." action={<span className="count-chip">{data?.pagination?.total ?? '—'} records</span>}>
    <section className="panel">
      <div className="filters-row"><SearchInput value={filters.search} onChange={(search) => setFilters((current) => ({ ...current, search, page: 1 }))} onSearch={load} placeholder="Search FDR or institution" /><SelectField ariaLabel="Workflow status" value={filters.workflowStatus} onChange={(workflowStatus) => setFilters((current) => ({ ...current, workflowStatus, page: 1 }))} options={workflowOptions} includeAll="All workflow statuses" /></div>
      {error && <Notice tone="danger">{error}</Notice>}
      {data?.records?.length ? <><div className="table-scroll"><table><thead><tr><th>Instrument</th><th>Institution</th><th>Amount</th><th>Maturity</th><th>Status</th><th>Submitted</th><th /></tr></thead><tbody>{data.records.map((record) => <tr key={record.id}><td><b>{record.fdrNumber}</b><small className="table-sub">{record.bankName}</small></td><td>{record.institution?.name}<small className="table-sub">{record.institution?.institutionCode}</small></td><td>{formatMoney(record.amount, record.currency)}</td><td>{formatDate(record.maturityDate)}</td><td><StatusPill value={record.workflowStatus} /></td><td>{formatDate(record.submittedAt)}</td><td><LinkButton to={`/admin/review/${record.id}`} variant="text">Review →</LinkButton></td></tr>)}</tbody></table></div><Pagination value={data.pagination} onChange={(page) => setFilters((current) => ({ ...current, page }))} /></> : <EmptyState title="Queue is clear" detail="No records match the selected filters." />}
    </section>
  </PageHeader>;
}

function ReviewDetailPage() {
  const { id } = useParams();
  const { request, token } = useAuth();
  const [data, setData] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => request(`/admin/fdrs/${id}/review`).then(setData).catch((requestError) => setError(requestError.message)), [request, id]);
  useEffect(() => { load(); }, [load]);
  const decide = async (decision) => {
    if (reason.trim().length < 5) { setError('Enter a review reason of at least five characters.'); return; }
    setBusy(true); setError('');
    try { await request(`/admin/fdrs/${id}/review`, { method: 'POST', body: { decision, reason } }); await load(); setReason(''); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  if (!data) return <PageHeader eyebrow="REVIEW DETAIL" title="Submission review">{error ? <Notice tone="danger">{error}</Notice> : <LoadingState label="Loading review details…" />}</PageHeader>;
  const record = data.fdr;
  return <PageHeader eyebrow="REVIEW DETAIL" title={record.fdrNumber} subtitle={`${data.institution?.name || 'Institution'} · ${record.bankName}`} action={<StatusPill value={record.workflowStatus} />}>
    {error && <Notice tone="danger">{error}</Notice>}
    <div className="detail-grid">
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">SUBMITTED VALUES</p><h2>Record summary</h2></div></div><DetailGrid rows={[['Institution', data.institution?.name], ['Code', data.institution?.institutionCode], ['Bank / branch', `${record.bankName} / ${record.branch}`], ['Amount', formatMoney(record.amount, record.currency)], ['Issue date', formatDate(record.issueDate)], ['Maturity date', formatDate(record.maturityDate)], ['Financial status', record.financialStatus]]} /><button className="button button-secondary top-gap" onClick={() => saveAuthenticatedDownload({ path: `/fdrs/${id}/document`, token, filename: record.document?.fileName })}>↓ Open supporting document</button></section>
      <section className="panel"><p className="eyebrow">REVIEW DECISION</p><h2>Record an outcome</h2><TextArea label="Reason / observation" value={reason} onChange={setReason} minLength={5} maxLength={2000} required /><div className="button-row top-gap"><button className="button button-secondary" onClick={() => decide('request_correction')} disabled={busy}>Request correction</button><button className="button button-danger" onClick={() => decide('reject_submission')} disabled={busy}>Reject submission</button><button className="button button-primary" onClick={() => decide('complete_review')} disabled={busy}>Complete review</button></div><p className="muted small top-gap">Completing administrative review does not confirm bank authenticity.</p></section>
    </div>
    <section className="panel top-gap"><p className="eyebrow">OCR & FORENSICS</p><h2>Document analysis</h2>
      <p className="muted">OCR status: {record.ocr?.status || 'not started'}</p>
      {record.ocr?.extractedFields && <ComparisonTable submitted={record.institutionSubmitted || record} extracted={record.ocr.extractedFields} comparisons={record.ocr.comparisons || {}} />}
      {record.forensic && <ForensicPanel analysis={record.forensic} />}
    </section>
    <section className="panel top-gap"><p className="eyebrow">AUDIT TRAIL</p><h2>Review history</h2>
      {record.reviewHistory?.length ? <div className="history-list">{record.reviewHistory.map((item) => <div className="history-item" key={item.id}><span className="history-mark" /><div><b>{labelize(item.decision)}</b><p>{item.reason}</p><small>{item.actor?.fullName || 'Official'} · {formatDate(item.timestamp)}</small></div></div>)}</div> : <p className="muted">No review decisions recorded.</p>}
    </section>
    <div className="detail-grid top-gap">
      <section className="panel"><p className="eyebrow">RENEWAL HISTORY</p><h2>Linked instruments</h2>{record.replacementOf ? <p>Replaces <b>{record.replacementOf.fdrNumber}</b> · <StatusPill value={record.replacementOf.workflowStatus} /></p> : null}{record.replacements?.length ? record.replacements.map((replacement) => <p key={replacement.id}><LinkButton to={`/admin/review/${replacement.id}`} variant="text">{replacement.fdrNumber}</LinkButton> · <StatusPill value={replacement.workflowStatus} /></p>) : !record.replacementOf && <p className="muted">No linked replacement instruments.</p>}</section>
      <section className="panel"><p className="eyebrow">RELEASE REQUESTS</p><h2>Request status</h2>{record.releaseRequests?.length ? record.releaseRequests.map((item, index) => <div className="history-item" key={`${item.createdAt}-${index}`}><span className="history-mark" /><div><b><StatusPill value={item.status} /></b><p>{item.reason}</p><small>Submitted {formatDate(item.createdAt)}</small></div></div>) : <p className="muted">No release/refund requests.</p>}</section>
    </div>
  </PageHeader>;
}

function InstitutionAdminPage() {
  const { request } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    try { setResult(await request(`/admin/institutions?${params}`)); setError(''); }
    catch (requestError) { setError(requestError.message); }
  }, [request, search, status, page]);
  useEffect(() => { load(); }, [load]);
  return <PageHeader eyebrow="INSTITUTION ADMINISTRATION" title="Institutions" subtitle="Review institution registrations and record permitted status transitions.">
    <section className="panel"><div className="filters-row"><SearchInput value={search} onChange={(value) => { setSearch(value); setPage(1); }} onSearch={load} placeholder="Search name or institution code" /><select className="select-control" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{['pending', 'active', 'inactive', 'suspended'].map((value) => <option key={value}>{value}</option>)}</select></div>
      {error && <Notice tone="danger">{error}</Notice>}
      {result?.institutions?.length ? <><div className="table-scroll"><table><thead><tr><th>Institution</th><th>Contact</th><th>Status</th><th>Registered</th><th>Review</th></tr></thead><tbody>{result.institutions.map((item) => <tr key={item.id}><td><b>{item.name}</b><small className="table-sub">{item.institutionCode}</small></td><td>{item.contactEmail}<small className="table-sub">{item.contactPhone}</small></td><td><StatusPill value={item.status} /></td><td>{formatDate(item.createdAt)}</td><td><InstitutionReview institution={item} afterSave={load} /></td></tr>)}</tbody></table></div><Pagination value={result.pagination} onChange={setPage} /></> : <EmptyState title="No institutions found" detail="Try changing the search or status filter." />}
    </section>
  </PageHeader>;
}

function InstitutionReview({ institution, afterSave }) {
  const { request } = useAuth();
  const [status, setStatus] = useState(institution.status === 'pending' ? 'active' : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(null);
  const allowed = institution.status === 'pending'
    ? ['active', 'inactive']
    : institution.status === 'active' ? ['suspended'] : institution.status === 'suspended' ? ['active'] : [];
  const submit = async () => {
    if (!status || reason.trim().length < 5) { setError('Choose a permitted status and enter a reason (at least 5 characters).'); return; }
    setBusy(true); setError('');
    try { await request(`/admin/institutions/${institution.id}/status`, { method: 'PATCH', body: { status, reason } }); await afterSave(); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  const toggleDetails = async () => {
    if (details) { setDetails(null); return; }
    try { setDetails(await request(`/admin/institutions/${institution.id}`)); }
    catch (requestError) { setError(requestError.message); }
  };
  return <div className="institution-review-wrap">
    <div className="inline-review"><select className="select-control select-compact" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">No action</option>{allowed.map((value) => <option key={value}>{value}</option>)}</select><input className="input-control input-compact" placeholder="Reason" value={reason} onChange={(event) => setReason(event.target.value)} /><button className="button button-secondary button-small" onClick={submit} disabled={busy || !status}>{busy ? 'Saving…' : 'Save'}</button><button className="button button-quiet button-small" onClick={toggleDetails}>{details ? 'Hide history' : 'History'}</button>{error && <small className="error-text">{error}</small>}</div>
    {details?.reviewHistory?.length > 0 && <div className="institution-history">{details.reviewHistory.map((entry, index) => <p key={`${entry.timestamp}-${index}`}><b>{labelize(entry.previousStatus)} → {labelize(entry.newStatus)}</b><span>{entry.reason}</span><small>{entry.actor?.fullName || 'Official'} · {formatDate(entry.timestamp)}</small></p>)}</div>}
  </div>;
}

function ReleaseQueuePage() {
  const { request } = useAuth();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (status) params.set('status', status);
    try { setData(await request(`/admin/release-requests?${params}`)); setError(''); }
    catch (requestError) { setError(requestError.message); }
  }, [request, status, page]);
  useEffect(() => { load(); }, [load]);
  return <PageHeader eyebrow="FINANCIAL OPERATIONS" title="Release / refund requests" subtitle="Track request decisions. Approval records an administrative outcome only; it does not transfer funds.">
    <section className="panel"><div className="filters-row"><SelectField ariaLabel="Request status" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={['submitted', 'information_requested', 'approved', 'rejected']} includeAll="All request statuses" /></div>{error && <Notice tone="danger">{error}</Notice>}
      {data?.requests?.length ? <><div className="table-scroll"><table><thead><tr><th>FDR</th><th>Institution</th><th>Reason</th><th>Status</th><th>Decision</th></tr></thead><tbody>{data.requests.map((item) => <tr key={item.id}><td><b>{item.fdr?.fdrNumber || item.fdrId}</b></td><td>{item.institution?.name || '—'}</td><td>{item.reason}</td><td><StatusPill value={item.status} /></td><td><ReleaseDecision requestItem={item} onSaved={load} /></td></tr>)}</tbody></table></div><Pagination value={data.pagination} onChange={setPage} /></> : <EmptyState title="No release requests" detail="Requests will appear here when an institution submits one." />}
    </section>
  </PageHeader>;
}

function ReleaseDecision({ requestItem, onSaved }) {
  const { request } = useAuth();
  const [decision, setDecision] = useState('request_information');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (['approved', 'rejected'].includes(requestItem.status)) return <small className="muted">Finalized</small>;
  if (requestItem.status !== 'submitted') return <small className="muted">Awaiting institution resubmission</small>;
  const submit = async () => {
    if (reason.trim().length < 5) return setError('Provide a reason of at least 5 characters.');
    setBusy(true); setError('');
    try { await request(`/admin/release-requests/${requestItem.id}/decision`, { method: 'POST', body: { decision, reason } }); await onSaved(); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  return <div className="inline-review release-inline"><select className="select-control select-compact" value={decision} onChange={(event) => setDecision(event.target.value)}><option value="request_information">Request information</option><option value="approve_request">Approve request</option><option value="reject_request">Reject request</option></select><input className="input-control input-compact" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Decision reason" /><button className="button button-secondary button-small" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Record'}</button>{error && <small className="error-text">{error}</small>}</div>;
}

function ReportsPage() {
  const { request, token } = useAuth();
  const [filters, setFilters] = useState({ page: 1, limit: 20, search: '', workflowStatus: '', maturityFrom: '', maturityTo: '', institutionId: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: filters.page, limit: filters.limit });
    for (const key of ['search', 'workflowStatus', 'maturityFrom', 'maturityTo', 'institutionId']) if (filters[key]) params.set(key, filters[key]);
    try { setResult(await request(`/admin/reports/fdrs?${params}`)); setError(''); }
    catch (requestError) { setError(requestError.message); }
  }, [request, filters]);
  useEffect(() => { load(); }, [load]);
  const exportCsv = async () => {
    const params = new URLSearchParams();
    for (const key of ['search', 'workflowStatus', 'maturityFrom', 'maturityTo', 'institutionId']) if (filters[key]) params.set(key, filters[key]);
    try {
      const blob = await apiRequest(`/admin/reports/fdrs/export?${params}`, { token, responseType: 'blob' });
      downloadBlob(blob, 'fdr-management-report.csv');
    } catch (requestError) { setError(requestError.message); }
  };
  const set = (key) => (value) => setFilters((current) => ({ ...current, [key]: value, page: 1 }));
  return <PageHeader eyebrow="MANAGEMENT REPORTING" title="FDR reports" subtitle="Search and export safe operational summaries for authorized officials." action={<button className="button button-secondary" onClick={exportCsv}>↓ Export CSV</button>}>
    <section className="panel">
      <div className="report-filters">
        <SearchInput value={filters.search} onChange={set('search')} onSearch={load} placeholder="FDR number, institution or code" />
        <SelectField ariaLabel="Workflow status" value={filters.workflowStatus} onChange={set('workflowStatus')} options={workflowOptions} includeAll="All statuses" />
        <Field label="Maturity from" type="date" value={filters.maturityFrom} onChange={set('maturityFrom')} />
        <Field label="Maturity to" type="date" value={filters.maturityTo} onChange={set('maturityTo')} />
        <Field label="Institution ID (optional)" value={filters.institutionId} onChange={set('institutionId')} />
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {result?.records?.length ? <><div className="table-scroll"><table><thead><tr><th>Institution</th><th>FDR</th><th>Bank</th><th>Amount</th><th>Maturity</th><th>Workflow</th></tr></thead><tbody>{result.records.map((record) => <tr key={record.id}><td>{record.institution?.name}<small className="table-sub">{record.institution?.institutionCode}</small></td><td><b>{record.fdrNumber}</b></td><td>{record.bankName}</td><td>{formatMoney(record.amount, record.currency)}</td><td>{formatDate(record.maturityDate)}</td><td><StatusPill value={record.workflowStatus} /></td></tr>)}</tbody></table></div><Pagination value={result.pagination} onChange={(page) => setFilters((current) => ({ ...current, page }))} /></> : <EmptyState title="No report rows" detail="Set filters to search records. CSV export is limited to 5,000 rows." />}
    </section>
  </PageHeader>;
}

function NotificationsPage({ onUnreadChange }) {
  const { request } = useAuth();
  const [data, setData] = useState(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: '20', unreadOnly: String(unreadOnly) });
    try {
      const result = await request(`/notifications?${params}`);
      setData(result); onUnreadChange?.(result.unreadCount); setError('');
    } catch (requestError) { setError(requestError.message); }
  }, [request, unreadOnly, onUnreadChange, page]);
  useEffect(() => { load(); }, [load]);
  const markRead = async (id) => {
    try { await request(`/notifications/${id}/read`, { method: 'PATCH' }); await load(); }
    catch (requestError) { setError(requestError.message); }
  };
  const markAll = async () => {
    try { await request('/notifications/read-all', { method: 'PATCH' }); await load(); }
    catch (requestError) { setError(requestError.message); }
  };
  return <PageHeader eyebrow="INBOX" title="Notifications" subtitle="In-app reminders and workflow updates for your account." action={!!data?.unreadCount && <button className="button button-secondary" onClick={markAll}>Mark all read</button>}>
    <section className="panel"><div className="filters-row"><label className="check-label"><input type="checkbox" checked={unreadOnly} onChange={(event) => { setUnreadOnly(event.target.checked); setPage(1); }} /> Unread only</label><span className="count-chip">{data?.unreadCount ?? 0} unread</span></div>{error && <Notice tone="danger">{error}</Notice>}
      {data?.notifications?.length ? <><div className="notification-list">{data.notifications.map((item) => <article className={`notification-item ${item.readAt ? 'is-read' : ''}`} key={item.id}><span className="notification-symbol">{item.type === 'overdue_maturity' ? '!' : '◷'}</span><div className="notification-copy"><div className="notification-title"><b>{item.title}</b><small>{formatDateTime(item.createdAt)}</small></div><p>{item.message}</p>{item.metadata?.reminderStage && <StatusPill value={item.metadata.reminderStage} />}</div>{!item.readAt && <button className="button button-quiet button-small" onClick={() => markRead(item.id)}>Mark read</button>}</article>)}</div><Pagination value={data.pagination} onChange={setPage} /></> : <EmptyState title="You’re all caught up" detail="New reminders and workflow updates will appear here." />}
    </section>
  </PageHeader>;
}

function InstitutionProfilePage() {
  const { request } = useAuth();
  const [institution, setInstitution] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { request('/institutions/me').then(({ institution: data }) => { setInstitution(data); setForm(data); }).catch((requestError) => setError(requestError.message)); }, [request]);
  const update = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try { const result = await request('/institutions/me', { method: 'PATCH', body: { name: form.name, contactEmail: form.contactEmail, contactPhone: form.contactPhone, address: form.address } }); setInstitution(result.institution); setNotice('Profile updates saved. Status and institution code are controlled by official review.'); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  return <PageHeader eyebrow="INSTITUTION PROFILE" title={institution?.name || 'Institution profile'} subtitle="Update the permitted contact and display fields for your institution.">
    {error && <Notice tone="danger">{error}</Notice>}
    {institution ? <form className="panel form-stack form-panel" onSubmit={submit}><div className="profile-status-row"><div><span className="detail-label">Institution code</span><b>{institution.institutionCode}</b></div><div><span className="detail-label">Review status</span><StatusPill value={institution.status} /></div></div><div className="form-grid"><Field label="Display name" value={form.name || ''} onChange={update('name')} required /><Field label="Contact email" type="email" value={form.contactEmail || ''} onChange={update('contactEmail')} required /><Field label="Contact phone" value={form.contactPhone || ''} onChange={update('contactPhone')} required /><Field className="field-span" label="Address" value={form.address || ''} onChange={update('address')} required /></div>{notice && <Notice tone="success">{notice}</Notice>}<div><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button></div></form> : !error && <LoadingState label="Loading institution profile…" />}
  </PageHeader>;
}

function NotFoundPage() {
  return <PageHeader eyebrow="NOT FOUND" title="This page is unavailable" subtitle="The page may have moved or your account may not have access."><LinkButton to="/" variant="primary">Return to dashboard</LinkButton></PageHeader>;
}

function PageHeader({ eyebrow, title, subtitle, action, children }) {
  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{subtitle && <p className="page-subtitle">{subtitle}</p>}</div>{action && <div className="page-action">{action}</div>}</div>{children}</div>;
}

function BrandMark() { return <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>; }

function Field({ label, value, onChange, type = 'text', className = '', ...props }) {
  return <label className={`field ${className}`}><span>{label}</span><input className="input-control" type={type} value={value ?? ''} onChange={(event) => onChange(event.target.value)} {...props} /></label>;
}

function FileField({ label, onChange, accept, help, required }) {
  const [name, setName] = useState('');
  return <label className="field file-field"><span>{label}</span><span className="file-input-wrap"><input type="file" accept={accept} required={required} onChange={(event) => { const selected = event.target.files?.[0] || null; setName(selected?.name || ''); onChange(selected); }} /><span className="file-button">Choose file</span><span className="file-name">{name || 'No file selected'}</span></span>{help && <small>{help}</small>}</label>;
}

function TextArea({ label, value, onChange, ...props }) {
  return <label className="field"><span>{label}</span><textarea className="input-control textarea-control" value={value} onChange={(event) => onChange(event.target.value)} {...props} /></label>;
}

function SelectField({ ariaLabel, value, onChange, options, includeAll }) {
  return <select className="select-control" aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}><option value="">{includeAll}</option>{options.map((option) => typeof option === 'string' ? <option key={option} value={option}>{labelize(option)}</option> : <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

function SearchInput({ value, onChange, onSearch, placeholder }) {
  return <form className="search-control" onSubmit={(event) => { event.preventDefault(); onSearch(); }}><span>⌕</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /><button type="submit" className="search-submit">Search</button></form>;
}

function MetricCard({ label, value, icon, tone, hint }) {
  return <article className={`metric-card tone-${tone}`}><div className="metric-top"><span className="metric-icon">{icon}</span><span className="metric-spark">↗</span></div><strong>{value}</strong><span>{label}</span>{hint && <small>{hint}</small>}</article>;
}

function StatusBars({ values }) {
  const entries = Object.entries(values);
  const max = Math.max(...entries.map(([, count]) => count), 1);
  return entries.length ? <div className="status-bars">{entries.map(([key, count]) => <div className="status-bar-row" key={key}><span>{labelize(key)}</span><div className="bar-track"><span style={{ width: `${Math.max(3, (count / max) * 100)}%` }} /></div><b>{count}</b></div>)}</div> : <p className="muted">No workflow counts are available.</p>;
}

function DetailGrid({ rows }) {
  return <dl className="detail-list">{rows.map(([label, value]) => <div className="detail-row" key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>;
}

function Pagination({ value, onChange }) {
  if (!value || value.pages <= 1) return null;
  return <div className="pagination"><span>Page {value.page} of {value.pages} <span className="muted">· {value.total} results</span></span><div><button className="button button-secondary button-small" onClick={() => onChange(value.page - 1)} disabled={value.page <= 1}>← Previous</button><button className="button button-secondary button-small" onClick={() => onChange(value.page + 1)} disabled={value.page >= value.pages}>Next →</button></div></div>;
}

function StatusPill({ value }) {
  const tone = ['active', 'approved', 'review_completed', 'completed', 'match', 'passed', 'no_signals_detected'].includes(value) ? 'good'
    : ['pending', 'submitted', 'under_review', 'queued', 'processing', 'correction_requested', 'information_requested', '15d', '30d', '7d'].includes(value) ? 'pending'
      : ['rejected', 'released', 'expired', 'failed', 'mismatch', 'high', 'overdue'].includes(value) ? 'danger'
        : 'neutral';
  return <span className={`status-pill status-${tone}`}><span />{labelize(value || 'unknown')}</span>;
}

function Notice({ tone = 'info', children }) { return <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>{children}</div>; }
function LoadingState({ label = 'Loading…' }) { return <div className="loading-state"><span className="spinner" />{label}</div>; }
function EmptyState({ title, detail, action }) { return <div className="empty-state"><span className="empty-icon">⌑</span><h3>{title}</h3><p>{detail}</p>{action}</div>; }
function LinkButton({ to, variant = 'primary', children, ...props }) { return <NavLink className={`button button-${variant}`} to={to} {...props}>{children}</NavLink>; }

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(date);
}
function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(date);
}
function formatMoney(value, currency = 'INR') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
}
function initials(value = '') { return value.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'U'; }
function roleLabel(role = '') { return ({ institution_admin: 'Institution admin', institution_user: 'Institution user', aicte_admin: 'AICTE admin', reviewer: 'Official reviewer' })[role] || labelize(role); }
function labelize(value = '') { return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }

const workflowOptions = ['draft', 'submitted', 'under_review', 'correction_requested', 'review_completed', 'approved', 'rejected', 'expired', 'released'];

export default App;
