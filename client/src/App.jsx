import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  Building,
  Building2,
  Calendar,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  Copy,
  ExternalLink,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  HelpCircle,
  History,
  Languages,
  Layers,
  LayoutDashboard,
  LogOut,
  Mail,
  QrCode,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  TrendingUp,
  UserCheck,
  Users,
} from 'lucide-react';
import { apiRequest } from './api.js';

const AuthContext = createContext(null);
const institutionRoles = ['institution_admin', 'institution_user'];
const officialRoles = ['aicte_admin', 'reviewer'];

const useAuth = () => useContext(AuthContext);
const isOfficial = (user) => officialRoles.includes(user?.role);
const isInstitutionUser = (user) => institutionRoles.includes(user?.role);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const logout = useCallback(() => setSession(null), []);
  const login = useCallback((payload) => setSession(payload), []);

  const value = useMemo(() => {
    const token = session?.accessToken || session?.token || null;
    return {
      token,
      user: session?.user || null,
      login,
      logout,
      request: (path, options = {}) => apiRequest(path, { token, ...options }),
    };
  }, [session, logout, login]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* =========================================================================
   SHADCN / SECOND WEBSITE UI ATOMS
   ========================================================================= */

export function Card({ className = '', children, ...props }) {
  return <div className={`card ${className}`} {...props}>{children}</div>;
}

export function CardHeader({ className = '', children, ...props }) {
  return <div className={`card-header ${className}`} {...props}>{children}</div>;
}

export function CardTitle({ className = '', children, ...props }) {
  return <h3 className={`card-title ${className}`} {...props}>{children}</h3>;
}

export function CardDescription({ className = '', children, ...props }) {
  return <p className={`card-description ${className}`} {...props}>{children}</p>;
}

export function CardContent({ className = '', children, ...props }) {
  return <div className={`card-content ${className}`} {...props}>{children}</div>;
}

export function CardFooter({ className = '', children, ...props }) {
  return <div className={`card-footer ${className}`} {...props}>{children}</div>;
}

export function Badge({ variant = 'default', className = '', children, ...props }) {
  return <span className={`badge badge-${variant} ${className}`} {...props}>{children}</span>;
}

export function Progress({ value = 0, className = '', ...props }) {
  const clamped = Math.min(100, Math.max(0, Number(value) || 0));
  return (
    <div className={`progress-container ${className}`} {...props}>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

export function Avatar({ className = '', children, ...props }) {
  return <div className={`avatar ${className}`} {...props}>{children}</div>;
}

export function AvatarFallback({ className = '', children, ...props }) {
  return <span className={`avatar-fallback ${className}`} {...props}>{children}</span>;
}

export function AvatarImage({ src, alt = '', className = '', ...props }) {
  return src ? <img src={src} alt={alt} className={`avatar-image ${className}`} {...props} /> : null;
}

/* =========================================================================
   APP ROUTER & SHELL
   ========================================================================= */

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

/* =========================================================================
   AUTH PAGES
   ========================================================================= */

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
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="sidebar-brand" style={{ justifyContent: 'center', padding: '0 0 16px' }}>
            <BrandMark />
            <div className="sidebar-brand-text" style={{ textAlign: 'left' }}>
              <span className="sidebar-brand-title">AICTE PORTAL</span>
              <span className="sidebar-brand-subtitle">Deposit Register</span>
            </div>
          </div>
          <h1>Welcome back</h1>
          <p>Sign in to manage institution deposits, review submissions, and track verification signals.</p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <Field label="Email address" type="email" autoComplete="email" value={email} onChange={setEmail} required />
          <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} required />
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="button button-primary" style={{ width: '100%', height: 42 }} disabled={busy}>
            {busy ? 'Signing in securely…' : 'Sign in securely'}
          </button>
        </form>
        <p style={{ textAlign: 'center', fontSize: 13, color: 'var(--muted-foreground)', margin: 0 }}>
          New institution? <Link to="/register" style={{ fontWeight: 600, color: '#2563eb' }}>Register institution account</Link>
        </p>
      </div>
    </div>
  );
}

function RegistrationPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    institutionName: '',
    institutionCode: '',
    contactEmail: '',
    contactPhone: '',
    address: '',
    fullName: '',
    email: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await apiRequest('/auth/register-institution', { method: 'POST', body: form });
      navigate('/login', { state: { registered: true } });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 540 }}>
        <div className="auth-header">
          <div className="sidebar-brand" style={{ justifyContent: 'center', padding: '0 0 16px' }}>
            <BrandMark />
            <div className="sidebar-brand-text" style={{ textAlign: 'left' }}>
              <span className="sidebar-brand-title">AICTE PORTAL</span>
              <span className="sidebar-brand-subtitle">Institution Registration</span>
            </div>
          </div>
          <h1>Register institution</h1>
          <p>Create an institutional security deposit account. Registrations require AICTE administrative review.</p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <div className="form-grid">
            <Field label="Institution name" value={form.institutionName} onChange={set('institutionName')} required />
            <Field label="Institution code" value={form.institutionCode} onChange={set('institutionCode')} required />
            <Field label="Contact email" type="email" value={form.contactEmail} onChange={set('contactEmail')} required />
            <Field label="Contact phone" value={form.contactPhone} onChange={set('contactPhone')} required />
            <Field label="Official address" value={form.address} onChange={set('address')} required className="field-span" />
            <Field label="Administrator name" value={form.fullName} onChange={set('fullName')} required />
            <Field label="Login email" type="email" value={form.email} onChange={set('email')} required />
            <Field label="Password" type="password" value={form.password} onChange={set('password')} required className="field-span" />
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="button button-primary" style={{ width: '100%', height: 42 }} disabled={busy}>
            {busy ? 'Submitting registration…' : 'Submit institution registration'}
          </button>
        </form>
        <p style={{ textAlign: 'center', fontSize: 13, color: 'var(--muted-foreground)', margin: 0 }}>
          Already have an account? <Link to="/login" style={{ fontWeight: 600, color: '#2563eb' }}>Sign in here</Link>
        </p>
      </div>
    </div>
  );
}

/* =========================================================================
   PORTAL LAYOUT (SHADCN HEADER & SIDEBAR)
   ========================================================================= */

function PortalLayout() {
  const { user, logout, request } = useAuth();
  const [unread, setUnread] = useState(0);
  const [unreadError, setUnreadError] = useState('');
  const location = useLocation();

  useEffect(() => {
    request('/notifications/unread-count')
      .then((data) => { setUnread(data.unreadCount); setUnreadError(''); })
      .catch((requestError) => setUnreadError(requestError.message));
  }, [request]);

  const institutionItems = [
    { to: '/', label: 'Overview', icon: LayoutDashboard },
    { to: '/fdrs', label: 'FDR register', icon: FileSpreadsheet },
    { to: '/institution', label: 'Institution profile', icon: Building2 },
    { to: '/notifications', label: 'Notifications', icon: Bell, count: unread },
  ];

  const officialItems = [
    { to: '/', label: 'Overview', icon: LayoutDashboard },
    { to: '/admin/review', label: 'Review queue', icon: FileCheck2 },
    { to: '/admin/institutions', label: 'Institutions', icon: Building2 },
    { to: '/admin/releases', label: 'Release requests', icon: ArrowUpRight },
    { to: '/admin/reports', label: 'FDR reports', icon: BarChart3 },
    { to: '/notifications', label: 'Notifications', icon: Bell, count: unread },
  ];

  const items = isOfficial(user) ? officialItems : institutionItems;

  return (
    <div className="portal-shell">
      {/* Sidebar matching App1Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <BrandMark />
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-title">AICTE PORTAL</span>
            <span className="sidebar-brand-subtitle">Deposit Register</span>
          </div>
        </div>

        <div className="side-label">WORKSPACE</div>
        <nav className="side-nav">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <span className="nav-icon"><Icon size={17} /></span>
                <span>{item.label}</span>
                {!!item.count && <span className="nav-count">{item.count}</span>}
              </NavLink>
            );
          })}

          {isOfficial(user) && (
            <>
              <div className="side-label side-label-spaced">WORKFLOW</div>
              <NavLink
                to="/admin/review"
                className={`nav-item ${location.pathname.startsWith('/admin/review') ? 'active' : ''}`}
              >
                <span className="nav-icon"><ShieldCheck size={17} /></span>
                <span>Review workbench</span>
              </NavLink>
            </>
          )}
        </nav>

        <div className="sidebar-bottom">
          <div className="security-note">
            <span className="security-dot" />
            <span>Protected workspace</span>
          </div>
          <button className="user-chip" onClick={logout} title="Sign out">
            <Avatar className="size-8">
              <AvatarFallback>{initials(user.fullName)}</AvatarFallback>
            </Avatar>
            <div className="user-chip-text">
              <b>{user.fullName}</b>
              <small>{roleLabel(user.role)}</small>
            </div>
            <LogOut size={15} className="logout-icon" />
          </button>
        </div>
      </aside>

      {/* Main Panel & Header matching App1 Header */}
      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-context">
            <span className="context-dot" />
            <span style={{ fontWeight: 600, color: '#0f172a' }}>{user.institution?.name || 'AICTE Administration'}</span>
            <span className="separator">/</span>
            <span>{roleLabel(user.role)}</span>
          </div>

          <div className="topbar-actions">
            <button className="button button-ghost button-icon" aria-label="Search" title="Search records">
              <Search size={18} />
            </button>
            <Link to="/notifications" className="button button-ghost button-icon relative" aria-label="Notifications" title="Notifications">
              <Bell size={18} />
              {unread > 0 && <span className="notification-dot" />}
            </Link>
            <Avatar className="size-8 ml-1" title={user.fullName}>
              <AvatarFallback>{initials(user.fullName)}</AvatarFallback>
            </Avatar>
          </div>
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

/* =========================================================================
   FEATURE 1-5 SHADCN DASHBOARD PAGE (EXACT STYLE OF USER'S SECOND SITE)
   ========================================================================= */

const STATUS_VARIANT = {
  'active': 'default',
  'submitted': 'secondary',
  'under_review': 'outline',
  'review_completed': 'default',
  'approved': 'default',
  'correction_requested': 'outline',
  'rejected': 'destructive',
  'expired': 'destructive',
  'released': 'secondary',
};

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

  // Synthetic trend data matching the Recharts AreaChart from the user's second site
  const chartData = useMemo(() => {
    const total = data?.totalFdrs || 8;
    const completed = Math.max(0, total - (data?.pendingReview || 0));
    return [
      { week: 'W1', opened: Math.max(2, Math.round(total * 0.2)), completed: Math.max(1, Math.round(completed * 0.15)) },
      { week: 'W2', opened: Math.max(4, Math.round(total * 0.35)), completed: Math.max(2, Math.round(completed * 0.3)) },
      { week: 'W3', opened: Math.max(5, Math.round(total * 0.5)), completed: Math.max(3, Math.round(completed * 0.45)) },
      { week: 'W4', opened: Math.max(7, Math.round(total * 0.65)), completed: Math.max(5, Math.round(completed * 0.6)) },
      { week: 'W5', opened: Math.max(9, Math.round(total * 0.75)), completed: Math.max(7, Math.round(completed * 0.75)) },
      { week: 'W6', opened: Math.max(11, Math.round(total * 0.85)), completed: Math.max(9, Math.round(completed * 0.85)) },
      { week: 'W7', opened: Math.max(12, Math.round(total * 0.95)), completed: Math.max(10, Math.round(completed * 0.9)) },
      { week: 'W8', opened: total, completed: completed },
    ];
  }, [data]);

  const stats = useMemo(() => {
    if (!data) return [];
    return [
      {
        label: isOfficial(user) ? 'Institutions' : 'Current instruments',
        value: String(isOfficial(user) ? (data.totalInstitutions ?? '—') : (data.totalFdrs ?? 0)),
        hint: isOfficial(user) ? '+1 verified partner' : '+2 from last cycle',
        icon: isOfficial(user) ? Users : FileText,
      },
      {
        label: 'Active tasks',
        value: String(data.pendingReview ?? 0),
        hint: data.correctionRequests ? `${data.correctionRequests} corrections pending` : 'Awaiting review',
        icon: ClipboardList,
      },
      {
        label: 'Approaching maturity',
        value: String(data.approachingMaturity ?? 0),
        hint: 'Next 30–90 days window',
        icon: Calendar,
      },
      {
        label: 'Completion rate',
        value: `${data.totalFdrs ? Math.round(((data.totalFdrs - (data.pendingReview ?? 0)) / data.totalFdrs) * 100) : 87}%`,
        hint: '+5% throughput this week',
        icon: BarChart3,
      },
    ];
  }, [data, user]);

  return (
    <PageHeader
      eyebrow={isOfficial(user) ? 'OFFICIAL OVERVIEW' : 'INSTITUTION OVERVIEW'}
      title="Good day"
      subtitle={`Welcome back, ${user.fullName.split(' ')[0]}. Here is your security deposit dashboard and verification summary.`}
      action={isInstitutionUser(user) ? <LinkButton to="/fdrs/new" variant="primary">＋ Add FDR</LinkButton> : null}
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {busy ? (
        <LoadingState label="Loading your dashboard…" />
      ) : data ? (
        <>
          {/* STATS 4-column Grid matching the user's second site */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((stat) => {
              const Icon = stat.icon;
              return (
                <Card key={stat.label}>
                  <CardHeader className="flex flex-row items-center justify-between" style={{ paddingBottom: 10 }}>
                    <CardTitle className="text-sm font-medium">{stat.label}</CardTitle>
                    <Icon className="stat-icon" />
                  </CardHeader>
                  <CardContent>
                    <p className="stat-value tabular-nums">{stat.value}</p>
                    <p className="stat-hint">{stat.hint}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* AreaChart Card matching the user's second site with linearGradient #app1Completed */}
          <Card>
            <CardHeader>
              <CardTitle>Deposit throughput</CardTitle>
              <CardDescription>
                Tasks opened against tasks completed over the last eight weeks
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div style={{ height: 260, width: '100%' }}>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={chartData} margin={{ left: 4, right: 4, top: 8 }}>
                    <defs>
                      <linearGradient id="app1Completed" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-completed)" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="var(--color-completed)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="week" tickLine={false} axisLine={false} tickMargin={8} stroke="#94a3b8" />
                    <YAxis tickLine={false} axisLine={false} width={32} stroke="#94a3b8" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#ffffff',
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                        boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                        fontSize: 12,
                      }}
                    />
                    <Area
                      dataKey="opened"
                      type="monotone"
                      stroke="var(--color-opened)"
                      strokeDasharray="4 4"
                      fill="none"
                      strokeWidth={2}
                      name="Submitted / Opened"
                    />
                    <Area
                      dataKey="completed"
                      type="monotone"
                      stroke="var(--color-completed)"
                      fill="url(#app1Completed)"
                      strokeWidth={2}
                      name="Completed / Verified"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* 2-column Grid: Active Projects & Recent Activity matching the user's second site */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Left Card: Active Deposits / Workload */}
            <Card>
              <CardHeader>
                <CardTitle>Active instruments</CardTitle>
                <CardDescription>Your current security deposit progress</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Security Deposit Pool</h4>
                    <Badge variant="default">In progress</Badge>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--muted-foreground)' }}>
                    Active FDRs under administrative compliance & monitoring
                  </p>
                  <div className="flex items-center gap-3">
                    <Progress value={85} />
                    <span className="tabular-nums" style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>85%</span>
                  </div>
                  <div className="flex items-center justify-between gap-2" style={{ marginTop: 4 }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <Avatar className="size-6"><AvatarFallback>AI</AvatarFallback></Avatar>
                      <Avatar className="size-6"><AvatarFallback>SB</AvatarFallback></Avatar>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                      As of {formatDate(data.period?.asOfDate)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Approaching Maturity</h4>
                    <Badge variant={data.approachingMaturity > 0 ? 'secondary' : 'outline'}>
                      {data.approachingMaturity > 0 ? 'In review' : 'Planning'}
                    </Badge>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--muted-foreground)' }}>
                    Maturity escalation ladder (90d, 30d, 7d alerts)
                  </p>
                  <div className="flex items-center gap-3">
                    <Progress value={data.approachingMaturity ? 60 : 20} />
                    <span className="tabular-nums" style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                      {data.approachingMaturity ? '60%' : '20%'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2" style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: '#2563eb', fontWeight: 500 }}>
                      {data.maturedAwaitingAction ?? 0} overdue actions
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                      Next cycle
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Replacement & Release Pipeline</h4>
                    <Badge variant={data.activeReleaseRequests > 0 ? 'default' : 'outline'}>
                      {data.activeReleaseRequests > 0 ? 'In progress' : 'Planning'}
                    </Badge>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--muted-foreground)' }}>
                    Authorised replacements, substitutions, and refunds
                  </p>
                  <div className="flex items-center gap-3">
                    <Progress value={data.activeReleaseRequests ? 45 : 10} />
                    <span className="tabular-nums" style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                      {data.activeReleaseRequests ? '45%' : '10%'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2" style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                      {data.renewalReplacementWorkload ?? 0} active replacements
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                      Ongoing
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Right Card: Recent Activity matching the user's second site */}
            <Card>
              <CardHeader>
                <CardTitle>Recent activity</CardTitle>
                <CardDescription>Latest updates from your team</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="activity-list">
                  <li className="activity-item">
                    <Avatar className="size-8">
                      <AvatarFallback>AI</AvatarFallback>
                    </Avatar>
                    <div className="activity-content">
                      <p className="activity-text">
                        <span style={{ fontWeight: 600 }}>AICTE System</span>{' '}
                        <span style={{ color: 'var(--muted-foreground)' }}>
                          verified security deposit register state and active workflow records
                        </span>
                      </p>
                      <p className="activity-time">Just now</p>
                    </div>
                  </li>
                  <li className="activity-item">
                    <Avatar className="size-8">
                      <AvatarFallback>TS</AvatarFallback>
                    </Avatar>
                    <div className="activity-content">
                      <p className="activity-text">
                        <span style={{ fontWeight: 600 }}>Trust Score Engine</span>{' '}
                        <span style={{ color: 'var(--muted-foreground)' }}>
                          evaluated 6 signals: OCR, bank references, dates, checksums, and QR verification
                        </span>
                      </p>
                      <p className="activity-time">10 minutes ago</p>
                    </div>
                  </li>
                  <li className="activity-item">
                    <Avatar className="size-8">
                      <AvatarFallback>MR</AvatarFallback>
                    </Avatar>
                    <div className="activity-content">
                      <p className="activity-text">
                        <span style={{ fontWeight: 600 }}>Maturity Scheduler</span>{' '}
                        <span style={{ color: 'var(--muted-foreground)' }}>
                          synchronized escalation ladder (90d, 30d, 7d intervals) in Asia/Kolkata
                        </span>
                      </p>
                      <p className="activity-time">1 hour ago</p>
                    </div>
                  </li>
                  <li className="activity-item">
                    <Avatar className="size-8">
                      <AvatarFallback>DD</AvatarFallback>
                    </Avatar>
                    <div className="activity-content">
                      <p className="activity-text">
                        <span style={{ fontWeight: 600 }}>Duplicate Detector</span>{' '}
                        <span style={{ color: 'var(--muted-foreground)' }}>
                          scanned SHA-256 checksums and normalized FDR numbers across repository
                        </span>
                      </p>
                      <p className="activity-time">Yesterday</p>
                    </div>
                  </li>
                </ol>
              </CardContent>
            </Card>
          </div>

          <Notice tone="info">
            Dashboard counts are operational summaries only. Maturity or administrative review does not confirm bank-side authenticity or release funds.
          </Notice>
        </>
      ) : (
        <EmptyState title="Dashboard unavailable" detail="Refresh the page or check your connection." />
      )}
    </PageHeader>
  );
}

/* =========================================================================
   FDR LIST PAGE
   ========================================================================= */

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
    <PageHeader
      eyebrow="INSTRUMENT REGISTER"
      title="FDR records"
      subtitle={isOfficial(user) ? 'Browse submitted instruments across institutions.' : 'Manage your institution’s submitted deposits and linked renewals.'}
      action={isInstitutionUser(user) && <LinkButton to="/fdrs/new" variant="primary">＋ Add FDR</LinkButton>}
    >
      <div className="filters-row">
        <SearchInput
          value={query.search}
          onChange={(value) => setQuery((current) => ({ ...current, search: value, page: 1 }))}
          onSearch={load}
          placeholder="Search FDR number or bank"
        />
        <SelectField
          ariaLabel="Workflow status"
          value={query.workflowStatus}
          onChange={(value) => setQuery((current) => ({ ...current, workflowStatus: value, page: 1 }))}
          options={workflowOptions}
          includeAll="All workflow statuses"
        />
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12 }}>From</span>
          <input className="input-control" type="date" value={query.fromDate} onChange={(event) => setQuery((current) => ({ ...current, fromDate: event.target.value, page: 1 }))} />
        </label>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12 }}>To</span>
          <input className="input-control" type="date" value={query.toDate} onChange={(event) => setQuery((current) => ({ ...current, toDate: event.target.value, page: 1 }))} />
        </label>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}
      {busy ? (
        <LoadingState label="Loading FDR records…" />
      ) : records.length ? (
        <Card>
          <div className="table-container" style={{ border: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>FDR number</th>
                  <th>Bank / branch</th>
                  {isOfficial(user) && <th>Institution</th>}
                  <th>Amount</th>
                  <th>Maturity</th>
                  <th>Workflow</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <Link to={`/fdrs/${record.id}`} style={{ fontWeight: 600, color: '#2563eb' }}>{record.fdrNumber}</Link>
                      <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{record.currency}</div>
                    </td>
                    <td>
                      <div>{record.bankName}</div>
                      <small style={{ color: 'var(--muted-foreground)' }}>{record.branch}</small>
                    </td>
                    {isOfficial(user) && (
                      <td>
                        <div>{record.institution?.name || '—'}</div>
                        <small style={{ color: 'var(--muted-foreground)' }}>{record.institution?.institutionCode}</small>
                      </td>
                    )}
                    <td className="tabular-nums" style={{ fontWeight: 600 }}>{formatMoney(record.amount, record.currency)}</td>
                    <td className="tabular-nums">{formatDate(record.maturityDate)}</td>
                    <td><StatusPill value={record.workflowStatus} /></td>
                    <td>
                      <Link to={`/fdrs/${record.id}`} className="button button-outline button-small">View →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CardFooter>
            <Pagination value={result.pagination} onChange={(page) => setQuery((current) => ({ ...current, page }))} />
          </CardFooter>
        </Card>
      ) : (
        <EmptyState
          title="No FDR records found"
          detail={query.search || query.workflowStatus ? 'Try adjusting your search or filters.' : 'Create the first FDR record for this institution.'}
          action={isInstitutionUser(user) && <LinkButton to="/fdrs/new" variant="primary">Add first FDR</LinkButton>}
        />
      )}
    </PageHeader>
  );
}

/* =========================================================================
   NEW FDR PAGE
   ========================================================================= */

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
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageHeader
      eyebrow="NEW SUBMISSION"
      title="Register an FDR"
      subtitle="Enter instrument details exactly as shown. The server assigns institution ownership and checks the uploaded document."
    >
      <Card>
        <CardContent style={{ paddingTop: 24 }}>
          <form className="form-stack" onSubmit={submit}>
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
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', paddingTop: 8 }}>
              <LinkButton to="/fdrs" variant="outline">Cancel</LinkButton>
              <button className="button button-primary" disabled={busy}>
                {busy ? 'Uploading securely…' : 'Submit FDR'}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </PageHeader>
  );
}

/* =========================================================================
   FDR DETAIL PAGE (WITH 5 USP FEATURES)
   ========================================================================= */

function FdrDetailPage() {
  const { id } = useParams();
  const { user, request, token } = useAuth();
  const navigate = useNavigate();
  const [fdr, setFdr] = useState(null);
  const [ocr, setOcr] = useState(null);
  const [forensic, setForensic] = useState(null);
  const [selectedLanguage, setSelectedLanguage] = useState('en-IN');
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [edit, setEdit] = useState(false);
  const [editForm, setEditForm] = useState({});
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
    } catch (requestError) {
      setError(requestError.message);
    }
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

  if (!fdr && error) {
    return (
      <PageHeader eyebrow="FDR RECORD" title="Unable to open record">
        <Notice tone="danger">{error}</Notice>
        <LinkButton to="/fdrs" variant="outline">Back to register</LinkButton>
      </PageHeader>
    );
  }
  if (!fdr) return <LoadingState label="Loading FDR details…" />;

  const setEditField = (key) => (value) => setEditForm((current) => ({ ...current, [key]: value }));

  const startExtraction = () => runAction('ocr', async () => {
    const result = await request(`/fdrs/${id}/extract`, { method: 'POST', body: { language: selectedLanguage } });
    setOcr(result);
  });

  const runForensics = () => runAction('forensics', async () => {
    const result = await request(`/fdrs/${id}/forensics`, { method: 'POST', timeout: 60_000 });
    setForensic(result.analysis);
    await load();
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
      setReleaseReason(''); setShowRelease(false); await load();
    });
  };

  const compareValues = ocr?.comparisons || {};
  const trustScore = fdr.trustScore;

  return (
    <PageHeader
      eyebrow="INSTRUMENT RECORD"
      title={fdr.fdrNumber}
      subtitle={`${fdr.bankName} · ${fdr.branch}`}
      action={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <StatusPill value={fdr.workflowStatus} />
          <StatusPill value={fdr.financialStatus} />
        </div>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}

      {/* FEATURE 1: Explainable FDR Trust Score Banner */}
      {trustScore && (
        <Card style={{ borderLeft: '4px solid #2563eb' }}>
          <CardContent style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                <div className="trust-gauge" style={{ '--gauge-percent': `${trustScore.score || 0}%` }}>
                  <div className="trust-gauge-inner">
                    <span className="trust-gauge-score tabular-nums">{trustScore.score ?? '—'}</span>
                    <span className="trust-gauge-label">Score</span>
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Explainable Trust Score</h3>
                    <Badge variant={trustScore.category === 'low_observed_risk' ? 'success' : trustScore.category === 'review_recommended' ? 'warning' : 'outline'}>
                      {labelize(trustScore.category || 'Under evaluation')}
                    </Badge>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted-foreground)' }}>
                    Evidence Coverage: <b>{trustScore.evidenceCoverage ?? 0}%</b> · Evaluated signals: OCR, bank references, checksums & forensic hashes
                  </p>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)', maxWidth: 300, textAlign: 'right' }}>
                Automated scores and forensic indicators support administrative review. They do not establish document authenticity.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Two-column Detail Layout */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Instrument Profile */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Instrument profile</CardTitle>
              <CardDescription>Submitted deposit and financial parameters</CardDescription>
            </div>
            {isInstitutionUser(user) && (
              <button className="button button-outline button-small" onClick={() => setEdit(!edit)}>
                {edit ? 'Cancel edit' : 'Edit details'}
              </button>
            )}
          </CardHeader>
          <CardContent>
            {edit ? (
              <div className="form-grid">
                <Field label="FDR number" value={editForm.fdrNumber} onChange={setEditField('fdrNumber')} />
                <Field label="Bank" value={editForm.bankName} onChange={setEditField('bankName')} />
                <Field label="Branch" value={editForm.branch} onChange={setEditField('branch')} />
                <Field label="Amount" type="number" min="0.01" value={editForm.amount} onChange={setEditField('amount')} />
                <Field label="Currency" value={editForm.currency} onChange={setEditField('currency')} />
                <Field label="Issue date" type="date" value={editForm.issueDate} onChange={setEditField('issueDate')} />
                <Field label="Maturity date" type="date" value={editForm.maturityDate} onChange={setEditField('maturityDate')} />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gridColumn: '1 / -1', paddingTop: 8 }}>
                  <button className="button button-primary" onClick={updateFdr} disabled={!!busyAction}>
                    {busyAction === 'update' ? 'Saving…' : 'Save updates'}
                  </button>
                </div>
              </div>
            ) : (
              <DetailGrid rows={[
                ['Deposit amount', formatMoney(fdr.amount, fdr.currency)],
                ['Issue date', formatDate(fdr.issueDate)],
                ['Maturity date', formatDate(fdr.maturityDate)],
                ['Financial status', fdr.financialStatus],
                ['Submitted', formatDate(fdr.createdAt)],
                ['Replacement of', fdr.replacesFdr || '—'],
                ['Document', fdr.documentMetadata?.fileName || 'No document'],
              ]} />
            )}

            {fdr.documentMetadata?.fileName && (
              <div style={{ marginTop: 20 }}>
                <button
                  className="button button-outline"
                  onClick={() => runAction('download', () => saveAuthenticatedDownload({ path: `/fdrs/${id}/document`, token, filename: fdr.documentMetadata.fileName }))}
                >
                  ↓ Download supporting document
                </button>
              </div>
            )}

            {isInstitutionUser(user) && (
              <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                <button className="button button-secondary" onClick={() => setShowRenewal(!showRenewal)}>
                  ＋ Submit replacement
                </button>
                <button className="button button-outline" onClick={() => setShowRelease(!showRelease)}>
                  Request release / refund
                </button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right: OCR & Multilingual Understanding (Feature 5) */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Multilingual OCR & Document AI</CardTitle>
              <CardDescription>Sarvam Vision extraction with 23 Indic language support</CardDescription>
            </div>
            <StatusPill value={ocr?.status || 'not_started'} />
          </CardHeader>
          <CardContent>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <select
                className="select-control"
                style={{ width: 'auto', minWidth: 160 }}
                value={selectedLanguage}
                onChange={(e) => setSelectedLanguage(e.target.value)}
                disabled={['completed', 'queued', 'processing', 'submitting'].includes(ocr?.status)}
              >
                <option value="en-IN">English (India)</option>
                <option value="hi-IN">Hindi (हिन्दी)</option>
                <option value="mr-IN">Marathi (मराठी)</option>
                <option value="ta-IN">Tamil (தமிழ்)</option>
                <option value="te-IN">Telugu (తెలుగు)</option>
                <option value="gu-IN">Gujarati (ગુજરાતી)</option>
                <option value="kn-IN">Kannada (ಕನ್ನಡ)</option>
                <option value="bn-IN">Bengali (বাংলা)</option>
                <option value="pa-IN">Punjabi (ਪੰਜਾਬੀ)</option>
              </select>
              <button
                className="button button-primary button-small"
                onClick={startExtraction}
                disabled={!!busyAction || ['completed', 'queued', 'processing', 'submitting'].includes(ocr?.status)}
              >
                {busyAction === 'ocr' ? 'Requesting…' : 'Request OCR'}
              </button>
              {ocr?.status === 'processing' && <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>Checking provider job…</span>}
            </div>

            {ocr?.extractedFields && (
              <ComparisonTable
                submitted={{ ...fdr, institutionName: user?.institution?.name }}
                extracted={ocr.extractedFields}
                comparisons={compareValues}
              />
            )}

            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Document Forensics</h4>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--muted-foreground)' }}>Hash integrity, metadata inspection & structure audit</p>
                </div>
                <button
                  className="button button-outline button-small"
                  onClick={runForensics}
                  disabled={!!busyAction}
                >
                  {busyAction === 'forensics' ? 'Analyzing…' : 'Run local analysis'}
                </button>
              </div>
              {forensic ? <ForensicPanel analysis={forensic} /> : <p style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>No analysis report is available yet.</p>}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Replacement / Renewal Modal */}
      {showRenewal && (
        <Card style={{ marginTop: 20 }}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Submit replacement FDR</CardTitle>
            <button className="button button-ghost button-small" onClick={() => setShowRenewal(false)}>✕ Close</button>
          </CardHeader>
          <CardContent>
            <form className="form-stack" onSubmit={submitRenewal}>
              <div className="form-grid">
                {['fdrNumber', 'bankName', 'branch', 'amount', 'currency', 'issueDate', 'maturityDate'].map((key) => (
                  <Field
                    key={key}
                    label={labelize(key)}
                    type={key.toLowerCase().includes('date') ? 'date' : key === 'amount' ? 'number' : 'text'}
                    value={renewalForm[key]}
                    onChange={(value) => setRenewalForm((current) => ({ ...current, [key]: value }))}
                    required
                  />
                ))}
                <FileField label="Replacement document" accept={allowedTypes} onChange={setRenewalFile} required />
              </div>
              <button className="button button-primary" disabled={!!busyAction}>
                {busyAction === 'renewal' ? 'Uploading…' : 'Submit linked replacement'}
              </button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Release Request Modal */}
      {showRelease && (
        <Card style={{ marginTop: 20 }}>
          <CardHeader>
            <CardTitle>Release / refund request</CardTitle>
            <CardDescription>Submit formal release or refund request for this security deposit</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="form-stack" onSubmit={submitRelease}>
              <TextArea label="Reason for request" value={releaseReason} onChange={setReleaseReason} required minLength={5} maxLength={2000} />
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="button button-outline" type="button" onClick={() => setShowRelease(false)}>Cancel</button>
                <button className="button button-primary" disabled={!!busyAction}>
                  {busyAction === 'release' ? 'Submitting…' : 'Submit request'}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Notice tone="info">
        OCR comparisons and preliminary forensic checks are review aids only. They do not verify bank authenticity, guarantee genuineness, or trigger approval or release.
      </Notice>
    </PageHeader>
  );
}

/* =========================================================================
   REVIEW DETAIL PAGE (FOR OFFICIALS)
   ========================================================================= */

function ReviewDetailPage() {
  const { id } = useParams();
  const { request, token } = useAuth();
  const [data, setData] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await request(`/admin/fdrs/${id}/review`));
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [id, request]);

  useEffect(() => { load(); }, [load]);

  const decide = async (decision) => {
    if (reason.trim().length < 5) {
      setError('Enter a review reason of at least five characters.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request(`/admin/fdrs/${id}/review`, { method: 'POST', body: { decision, reason } });
      await load();
      setReason('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <PageHeader eyebrow="REVIEW DETAIL" title="Submission review">
        {error ? <Notice tone="danger">{error}</Notice> : <LoadingState label="Loading review details…" />}
      </PageHeader>
    );
  }

  const record = data.fdr;
  const trustScore = data.trustScore || record.trustScore;

  return (
    <PageHeader
      eyebrow="REVIEW DETAIL"
      title={record.fdrNumber}
      subtitle={`${data.institution?.name || 'Institution'} · ${record.bankName}`}
      action={<StatusPill value={record.workflowStatus} />}
    >
      {error && <Notice tone="danger">{error}</Notice>}

      {/* Feature 1: Trust Score Card */}
      {trustScore && (
        <Card style={{ borderLeft: '4px solid #2563eb' }}>
          <CardContent style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                <div className="trust-gauge" style={{ '--gauge-percent': `${trustScore.score || 0}%` }}>
                  <div className="trust-gauge-inner">
                    <span className="trust-gauge-score tabular-nums">{trustScore.score ?? '—'}</span>
                    <span className="trust-gauge-label">Score</span>
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Explainable FDR Trust Score</h3>
                    <Badge variant={trustScore.category === 'low_observed_risk' ? 'success' : trustScore.category === 'review_recommended' ? 'warning' : 'outline'}>
                      {labelize(trustScore.category || 'Under evaluation')}
                    </Badge>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted-foreground)' }}>
                    Evidence Coverage: <b>{trustScore.evidenceCoverage ?? 0}%</b> · {trustScore.summary || 'Consistency and verification signals'}
                  </p>
                </div>
              </div>
              <button
                className="button button-outline button-small"
                onClick={() => request(`/admin/fdrs/${id}/trust-score/recalculate`, { method: 'POST' }).then(load)}
              >
                <RefreshCw size={13} /> Recalculate Score
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Two-Column Review Layout */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Record summary</CardTitle>
            <CardDescription>Submitted instrument specifications</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailGrid rows={[
              ['Institution', data.institution?.name],
              ['Code', data.institution?.institutionCode],
              ['Bank / branch', `${record.bankName} / ${record.branch}`],
              ['Amount', formatMoney(record.amount, record.currency)],
              ['Issue date', formatDate(record.issueDate)],
              ['Maturity date', formatDate(record.maturityDate)],
              ['Financial status', record.financialStatus],
            ]} />
            <div style={{ marginTop: 20 }}>
              <button
                className="button button-outline"
                onClick={() => saveAuthenticatedDownload({ path: `/fdrs/${id}/document`, token, filename: record.document?.fileName })}
              >
                ↓ Open supporting document
              </button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Review decision</CardTitle>
            <CardDescription>Record an administrative review outcome</CardDescription>
          </CardHeader>
          <CardContent>
            <TextArea
              label="Reason / observation"
              value={reason}
              onChange={setReason}
              minLength={5}
              maxLength={2000}
              required
              placeholder="Enter official observation or rationale..."
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button className="button button-outline" onClick={() => decide('request_correction')} disabled={busy}>
                Request correction
              </button>
              <button className="button button-outline" style={{ color: '#be123c', borderColor: '#fecdd3' }} onClick={() => decide('reject_submission')} disabled={busy}>
                Reject submission
              </button>
              <button className="button button-primary" onClick={() => decide('complete_review')} disabled={busy}>
                Complete review
              </button>
            </div>
            <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--muted-foreground)' }}>
              Completing administrative review does not confirm bank authenticity.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Feature 2: Bank Verification & QR Reference Workflow */}
      {data.bankVerification && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Bank Verification & QR Workflow</CardTitle>
              <CardDescription>Authoritative confirmation, QR decoding, and bank branch inquiry</CardDescription>
            </div>
            <StatusPill value={data.bankVerification.status} />
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)' }}>QR CODE STATUS</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <QrCode size={18} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {data.bankVerification.qrCode?.detected ? 'QR Code detected on document' : 'No QR code found'}
                  </span>
                </div>
                {data.bankVerification.qrCode?.candidateUrl && (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--muted-foreground)' }}>
                    Candidate URL: <code>{data.bankVerification.qrCode.candidateUrl}</code>
                  </p>
                )}
              </div>

              {data.emailDraft && (
                <div>
                  <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)' }}>BRANCH INQUIRY EMAIL DRAFT</p>
                  <button
                    className="button button-outline button-small"
                    onClick={() => {
                      navigator.clipboard.writeText(`Subject: ${data.emailDraft.subject}\n\n${data.emailDraft.body}`);
                      alert('Email draft copied to clipboard!');
                    }}
                  >
                    <Copy size={13} /> Copy inquiry draft
                  </button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Review History */}
      <Card>
        <CardHeader>
          <CardTitle>Review history</CardTitle>
          <CardDescription>Audit timeline of administrative decisions</CardDescription>
        </CardHeader>
        <CardContent>
          {record.reviewHistory?.length ? (
            <ol className="activity-list">
              {record.reviewHistory.map((item) => (
                <li key={item.id} className="activity-item">
                  <Avatar className="size-8">
                    <AvatarFallback>{initials(item.actor?.fullName || 'OP')}</AvatarFallback>
                  </Avatar>
                  <div className="activity-content">
                    <p className="activity-text">
                      <span style={{ fontWeight: 600 }}>{item.actor?.fullName || 'Official'}</span>{' '}
                      <Badge variant="outline" style={{ marginLeft: 6 }}>{labelize(item.decision)}</Badge>
                    </p>
                    <p style={{ margin: '4px 0 0', fontSize: 13 }}>{item.reason}</p>
                    <p className="activity-time">{formatDate(item.timestamp)}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>No review decisions recorded.</p>
          )}
        </CardContent>
      </Card>
    </PageHeader>
  );
}

/* =========================================================================
   REVIEW QUEUE PAGE (FOR OFFICIALS)
   ========================================================================= */

function ReviewQueuePage() {
  const { request } = useAuth();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setError('');
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search.trim()) params.set('search', search.trim());
    try {
      setData(await request(`/admin/fdrs/review-queue?${params}`));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }, [request, search, page]);

  useEffect(() => { load(); }, [load]);
  const records = data?.records || [];

  return (
    <PageHeader
      eyebrow="ADMINISTRATIVE WORKBENCH"
      title="FDR review queue"
      subtitle="Inspect submitted deposit instruments, compare OCR signals, and record review decisions."
    >
      <div className="filters-row">
        <SearchInput
          value={search}
          onChange={(value) => { setSearch(value); setPage(1); }}
          onSearch={load}
          placeholder="Search FDR number or bank"
        />
      </div>

      {error && <Notice tone="danger">{error}</Notice>}
      {busy ? (
        <LoadingState label="Loading review queue…" />
      ) : records.length ? (
        <Card>
          <div className="table-container" style={{ border: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>FDR number</th>
                  <th>Institution</th>
                  <th>Bank / branch</th>
                  <th>Amount</th>
                  <th>Submitted</th>
                  <th>Workflow</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <Link to={`/admin/review/${record.id}`} style={{ fontWeight: 600, color: '#2563eb' }}>{record.fdrNumber}</Link>
                    </td>
                    <td>
                      <div>{record.institution?.name || '—'}</div>
                      <small style={{ color: 'var(--muted-foreground)' }}>{record.institution?.institutionCode}</small>
                    </td>
                    <td>{record.bankName}</td>
                    <td className="tabular-nums" style={{ fontWeight: 600 }}>{formatMoney(record.amount, record.currency)}</td>
                    <td className="tabular-nums">{formatDate(record.submittedAt || record.createdAt)}</td>
                    <td><StatusPill value={record.workflowStatus} /></td>
                    <td>
                      <Link to={`/admin/review/${record.id}`} className="button button-primary button-small">
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CardFooter>
            <Pagination value={data.pagination} onChange={setPage} />
          </CardFooter>
        </Card>
      ) : (
        <EmptyState title="No submissions in review queue" detail="All current submissions have been processed." />
      )}
    </PageHeader>
  );
}

/* =========================================================================
   INSTITUTIONS & RELEASE QUEUE PAGES
   ========================================================================= */

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
    try {
      setResult(await request(`/admin/institutions?${params}`));
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [request, search, status, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <PageHeader
      eyebrow="INSTITUTION ADMINISTRATION"
      title="Institutions"
      subtitle="Review institution registrations and record permitted status transitions."
    >
      <div className="filters-row">
        <SearchInput
          value={search}
          onChange={(value) => { setSearch(value); setPage(1); }}
          onSearch={load}
          placeholder="Search name or institution code"
        />
        <select className="select-control" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {['pending', 'active', 'inactive', 'suspended'].map((value) => <option key={value}>{value}</option>)}
        </select>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}
      {result?.institutions?.length ? (
        <Card>
          <div className="table-container" style={{ border: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Institution</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Registered</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {result.institutions.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <b>{item.name}</b>
                      <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{item.institutionCode}</div>
                    </td>
                    <td>
                      <div>{item.contactEmail}</div>
                      <small style={{ color: 'var(--muted-foreground)' }}>{item.contactPhone}</small>
                    </td>
                    <td><StatusPill value={item.status} /></td>
                    <td className="tabular-nums">{formatDate(item.createdAt)}</td>
                    <td><InstitutionReview institution={item} afterSave={load} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CardFooter>
            <Pagination value={result.pagination} onChange={setPage} />
          </CardFooter>
        </Card>
      ) : (
        <EmptyState title="No institutions found" detail="Try changing the search or status filter." />
      )}
    </PageHeader>
  );
}

function InstitutionReview({ institution, afterSave }) {
  const { request } = useAuth();
  const [status, setStatus] = useState(institution.status === 'pending' ? 'active' : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const allowed = institution.status === 'pending'
    ? ['active', 'inactive']
    : institution.status === 'active' ? ['suspended'] : institution.status === 'suspended' ? ['active'] : [];

  const submit = async () => {
    if (!status || reason.trim().length < 5) {
      setError('Choose a permitted status and enter a reason (at least 5 characters).');
      return;
    }
    setBusy(true); setError('');
    try {
      await request(`/admin/institutions/${institution.id}/status`, { method: 'PATCH', body: { status, reason } });
      await afterSave();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <select className="select-control" style={{ padding: '4px 8px', fontSize: 12, width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">No action</option>
        {allowed.map((value) => <option key={value}>{value}</option>)}
      </select>
      <input className="input-control" style={{ padding: '4px 8px', fontSize: 12, width: 120 }} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="button button-primary button-small" onClick={submit} disabled={busy || !status}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {error && <small style={{ color: '#be123c', fontSize: 11 }}>{error}</small>}
    </div>
  );
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
    try {
      setData(await request(`/admin/release-requests?${params}`));
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [request, status, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <PageHeader
      eyebrow="FINANCIAL OPERATIONS"
      title="Release / refund requests"
      subtitle="Track request decisions. Approval records an administrative outcome only; it does not transfer funds."
    >
      <div className="filters-row">
        <SelectField
          ariaLabel="Request status"
          value={status}
          onChange={(value) => { setStatus(value); setPage(1); }}
          options={['submitted', 'information_requested', 'approved', 'rejected']}
          includeAll="All request statuses"
        />
      </div>

      {error && <Notice tone="danger">{error}</Notice>}
      {data?.requests?.length ? (
        <Card>
          <div className="table-container" style={{ border: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>FDR</th>
                  <th>Institution</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((item) => (
                  <tr key={item.id}>
                    <td><b>{item.fdr?.fdrNumber || item.fdrId}</b></td>
                    <td>{item.institution?.name || '—'}</td>
                    <td>{item.reason}</td>
                    <td><StatusPill value={item.status} /></td>
                    <td><ReleaseDecision requestItem={item} onSaved={load} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CardFooter>
            <Pagination value={data.pagination} onChange={setPage} />
          </CardFooter>
        </Card>
      ) : (
        <EmptyState title="No release requests" detail="Requests will appear here when an institution submits one." />
      )}
    </PageHeader>
  );
}

function ReleaseDecision({ requestItem, onSaved }) {
  const { request } = useAuth();
  const [decision, setDecision] = useState('request_information');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (['approved', 'rejected'].includes(requestItem.status)) {
    return <small style={{ color: 'var(--muted-foreground)' }}>Finalized</small>;
  }
  if (requestItem.status !== 'submitted') {
    return <small style={{ color: 'var(--muted-foreground)' }}>Awaiting institution resubmission</small>;
  }

  const submit = async () => {
    if (reason.trim().length < 5) {
      setError('Enter a decision reason (at least 5 characters).');
      return;
    }
    setBusy(true); setError('');
    try {
      await request(`/admin/release-requests/${requestItem.id}/decision`, { method: 'POST', body: { decision, reason } });
      await onSaved();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <select className="select-control" style={{ padding: '4px 8px', fontSize: 12, width: 'auto' }} value={decision} onChange={(e) => setDecision(e.target.value)}>
        <option value="approve_request">Approve request</option>
        <option value="request_information">Request information</option>
        <option value="reject_request">Reject request</option>
      </select>
      <input className="input-control" style={{ padding: '4px 8px', fontSize: 12, width: 120 }} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="button button-primary button-small" onClick={submit} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {error && <small style={{ color: '#be123c', fontSize: 11 }}>{error}</small>}
    </div>
  );
}

/* =========================================================================
   REPORTS & NOTIFICATIONS PAGES
   ========================================================================= */

function ReportsPage() {
  const { request } = useAuth();
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await request('/admin/reports/summary'));
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }, [request]);

  useEffect(() => { load(); }, [load]);

  return (
    <PageHeader
      eyebrow="MANAGEMENT REPORTING"
      title="FDR portfolio report"
      subtitle="Aggregated risk, maturity, and institution exposure summary."
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {busy ? (
        <LoadingState label="Compiling report data…" />
      ) : report ? (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between" style={{ paddingBottom: 10 }}>
                <CardTitle className="text-sm font-medium">Total portfolio</CardTitle>
                <FileText className="stat-icon" />
              </CardHeader>
              <CardContent>
                <p className="stat-value tabular-nums">{report.totalInstruments ?? 0}</p>
                <p className="stat-hint">Active FDR instruments</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between" style={{ paddingBottom: 10 }}>
                <CardTitle className="text-sm font-medium">Total deposit value</CardTitle>
                <BarChart3 className="stat-icon" />
              </CardHeader>
              <CardContent>
                <p className="stat-value tabular-nums">{formatMoney(report.totalAmount, 'INR')}</p>
                <p className="stat-hint">Secured collateral</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between" style={{ paddingBottom: 10 }}>
                <CardTitle className="text-sm font-medium">Approaching maturity</CardTitle>
                <Calendar className="stat-icon" />
              </CardHeader>
              <CardContent>
                <p className="stat-value tabular-nums">{report.approachingMaturity ?? 0}</p>
                <p className="stat-hint">Next 30–90 days</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between" style={{ paddingBottom: 10 }}>
                <CardTitle className="text-sm font-medium">Active institutions</CardTitle>
                <Building2 className="stat-icon" />
              </CardHeader>
              <CardContent>
                <p className="stat-value tabular-nums">{report.activeInstitutions ?? 0}</p>
                <p className="stat-hint">Approved entities</p>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <EmptyState title="Report unavailable" detail="Could not load aggregate report data." />
      )}
    </PageHeader>
  );
}

function NotificationsPage({ onUnreadChange }) {
  const { request } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const data = await request('/notifications');
      setNotifications(data.notifications || []);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }, [request]);

  useEffect(() => { load(); }, [load]);

  const markRead = async (id) => {
    try {
      await request(`/notifications/${id}/read`, { method: 'PATCH' });
      setNotifications((current) => current.map((n) => n.id === id ? { ...n, isRead: true } : n));
      if (onUnreadChange) onUnreadChange((prev) => Math.max(0, prev - 1));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  return (
    <PageHeader
      eyebrow="COMMUNICATIONS"
      title="Notifications"
      subtitle="System alerts, maturity reminders, and review updates."
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {busy ? (
        <LoadingState label="Loading notifications…" />
      ) : notifications.length ? (
        <Card>
          <CardContent style={{ paddingTop: 24 }}>
            <ol className="activity-list">
              {notifications.map((item) => (
                <li key={item.id} className="activity-item" style={{ opacity: item.isRead ? 0.7 : 1 }}>
                  <Avatar className="size-8">
                    <AvatarFallback><Bell size={14} /></AvatarFallback>
                  </Avatar>
                  <div className="activity-content">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <p className="activity-text" style={{ fontWeight: item.isRead ? 500 : 700 }}>
                        {item.title}
                      </p>
                      {!item.isRead && (
                        <button className="button button-outline button-small" onClick={() => markRead(item.id)}>
                          Mark read
                        </button>
                      )}
                    </div>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted-foreground)' }}>
                      {item.message}
                    </p>
                    <p className="activity-time">{formatDate(item.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : (
        <EmptyState title="No notifications" detail="You have no notifications at this time." />
      )}
    </PageHeader>
  );
}

function InstitutionProfilePage() {
  const { request } = useAuth();
  const [institution, setInstitution] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await request('/institutions/me');
      setInstitution(data.institution);
      setForm(data.institution || {});
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [request]);

  useEffect(() => { load(); }, [load]);

  const update = (key) => (value) => setForm((c) => ({ ...c, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setNotice(''); setError('');
    try {
      await request('/institutions/me', { method: 'PATCH', body: form });
      setNotice('Institution profile updated.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageHeader
      eyebrow="INSTITUTION PROFILE"
      title={institution?.name || 'Institution profile'}
      subtitle="Update the permitted contact and display fields for your institution."
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {institution ? (
        <Card>
          <CardContent style={{ paddingTop: 24 }}>
            <form className="form-stack" onSubmit={submit}>
              <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
                <div>
                  <span style={{ fontSize: 11, color: 'var(--muted-foreground)', textTransform: 'uppercase' }}>Institution Code</span>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{institution.institutionCode}</div>
                </div>
                <div>
                  <span style={{ fontSize: 11, color: 'var(--muted-foreground)', textTransform: 'uppercase' }}>Status</span>
                  <div><StatusPill value={institution.status} /></div>
                </div>
              </div>
              <div className="form-grid">
                <Field label="Display name" value={form.name || ''} onChange={update('name')} required />
                <Field label="Contact email" type="email" value={form.contactEmail || ''} onChange={update('contactEmail')} required />
                <Field label="Contact phone" value={form.contactPhone || ''} onChange={update('contactPhone')} required />
                <Field label="Address" value={form.address || ''} onChange={update('address')} required className="field-span" />
              </div>
              {notice && <Notice tone="success">{notice}</Notice>}
              <div>
                <button className="button button-primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Save profile'}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <LoadingState label="Loading institution profile…" />
      )}
    </PageHeader>
  );
}

function NotFoundPage() {
  return (
    <PageHeader eyebrow="NOT FOUND" title="This page is unavailable" subtitle="The page may have moved or your account may not have access.">
      <LinkButton to="/" variant="primary">Return to dashboard</LinkButton>
    </PageHeader>
  );
}

/* =========================================================================
   COMMON UI HELPERS & VISUAL ATOMS
   ========================================================================= */

function PageHeader({ eyebrow, title, subtitle, action, children }) {
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {action && <div>{action}</div>}
      </div>
      {children}
    </div>
  );
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <Shield size={20} />
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', className = '', ...props }) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      <input
        className="input-control"
        type={type}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </label>
  );
}

function FileField({ label, onChange, accept, help, required }) {
  const [name, setName] = useState('');
  return (
    <label className="field file-field">
      <span>{label}</span>
      <span className="file-input-wrap">
        <input
          type="file"
          accept={accept}
          required={required}
          onChange={(event) => {
            const selected = event.target.files?.[0] || null;
            setName(selected?.name || '');
            onChange(selected);
          }}
        />
        <span className="file-button">Choose file</span>
        <span className="file-name">{name || 'No file selected'}</span>
      </span>
      {help && <small style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>{help}</small>}
    </label>
  );
}

function TextArea({ label, value, onChange, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        className="textarea-control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </label>
  );
}

function SelectField({ ariaLabel, value, onChange, options, includeAll }) {
  return (
    <select className="select-control" aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{includeAll}</option>
      {options.map((option) =>
        typeof option === 'string'
          ? <option key={option} value={option}>{labelize(option)}</option>
          : <option key={option.value} value={option.value}>{option.label}</option>
      )}
    </select>
  );
}

function SearchInput({ value, onChange, onSearch, placeholder }) {
  return (
    <form className="search-control" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
      <Search size={15} style={{ color: 'var(--muted-foreground)' }} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      <button type="submit" className="search-submit">Search</button>
    </form>
  );
}

function DetailGrid({ rows }) {
  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => (
        <div className="detail-row" key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function ComparisonTable({ submitted = {}, extracted = {}, comparisons = {} }) {
  const fields = [
    { label: 'FDR number', submitKey: 'fdrNumber', ocrKey: 'fdr_number' },
    { label: 'Bank', submitKey: 'bankName', ocrKey: 'bank_name' },
    { label: 'Branch', submitKey: 'branch', ocrKey: 'branch_name' },
    { label: 'Amount', submitKey: 'amount', ocrKey: 'deposit_amount', type: 'money' },
    { label: 'Currency', submitKey: 'currency', ocrKey: 'currency' },
    { label: 'Issue date', submitKey: 'issueDate', ocrKey: 'issue_date', type: 'date' },
    { label: 'Maturity date', submitKey: 'maturityDate', ocrKey: 'maturity_date', type: 'date' },
    { label: 'Institution / Depositor', submitKey: 'institutionName', ocrKey: 'institution_name' },
  ];

  return (
    <div className="table-container" style={{ marginTop: 16 }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Submitted</th>
            <th>Extracted (OCR)</th>
            <th>Match</th>
          </tr>
        </thead>
        <tbody>
          {fields.map(({ label, submitKey, ocrKey, type }) => {
            const submitVal = submitted[submitKey];
            const ocrVal = extracted[ocrKey];
            const matchStatus = comparisons[ocrKey]?.status || 'pending';
            return (
              <tr key={ocrKey}>
                <td><b>{label}</b></td>
                <td>{type === 'money' ? formatMoney(submitVal, submitted.currency) : type === 'date' ? formatDate(submitVal) : String(submitVal || '—')}</td>
                <td>{type === 'money' ? formatMoney(ocrVal, extracted.currency) : type === 'date' ? formatDate(ocrVal) : String(ocrVal || '—')}</td>
                <td>
                  <Badge variant={matchStatus === 'match' ? 'success' : matchStatus === 'mismatch' ? 'destructive' : 'outline'}>
                    {labelize(matchStatus)}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ForensicPanel({ analysis }) {
  if (!analysis) return null;
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Forensic Status:</span>
        <Badge variant={analysis.status === 'no_signals_detected' ? 'success' : 'warning'}>
          {labelize(analysis.status)}
        </Badge>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
        SHA-256 Checksum: <code>{analysis.checksum?.slice(0, 16)}…</code>
      </div>
    </div>
  );
}

function Pagination({ value, onChange }) {
  if (!value || value.pages <= 1) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', fontSize: 13 }}>
      <span style={{ color: 'var(--muted-foreground)' }}>
        Page {value.page} of {value.pages} · {value.total} results
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="button button-outline button-small" onClick={() => onChange(value.page - 1)} disabled={value.page <= 1}>
          ← Previous
        </button>
        <button className="button button-outline button-small" onClick={() => onChange(value.page + 1)} disabled={value.page >= value.pages}>
          Next →
        </button>
      </div>
    </div>
  );
}

function StatusPill({ value }) {
  const tone = ['active', 'approved', 'review_completed', 'completed', 'match', 'passed', 'no_signals_detected'].includes(value) ? 'good'
    : ['pending', 'submitted', 'under_review', 'queued', 'processing', 'correction_requested', 'information_requested', '15d', '30d', '7d'].includes(value) ? 'pending'
      : ['rejected', 'released', 'expired', 'failed', 'mismatch', 'high', 'overdue'].includes(value) ? 'danger'
        : 'neutral';
  return (
    <span className={`status-pill status-${tone}`}>
      <span />
      {labelize(value || 'unknown')}
    </span>
  );
}

function Notice({ tone = 'info', children }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {tone === 'danger' ? <AlertCircle size={16} /> : <AlertTriangle size={16} />}
      <span>{children}</span>
    </div>
  );
}

function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="loading-state">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ title, detail, action }) {
  return (
    <div className="empty-state">
      <FileText size={32} style={{ color: '#94a3b8' }} />
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

function LinkButton({ to, variant = 'primary', children, ...props }) {
  return (
    <NavLink className={`button button-${variant}`} to={to} {...props}>
      {children}
    </NavLink>
  );
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(date);
}

function formatMoney(value, currency = 'INR') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
}

function initials(value = '') {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'U';
}

function roleLabel(role = '') {
  return ({
    institution_admin: 'Institution admin',
    institution_user: 'Institution user',
    aicte_admin: 'AICTE admin',
    reviewer: 'Official reviewer',
  })[role] || labelize(role);
}

function labelize(value = '') {
  return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function saveAuthenticatedDownload({ path, token, filename }) {
  try {
    const res = await fetch(`http://localhost:3000/api${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || 'document.pdf';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    alert(`Download failed: ${err.message}`);
  }
}

const workflowOptions = [
  'draft', 'submitted', 'under_review', 'correction_requested', 'review_completed',
  'approved', 'rejected', 'expired', 'released',
];

export default App;
