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

describe('PART 2 — Header and Navigation Redesign', () => {
  beforeEach(() => {
    localStorage.clear();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders institutional branding with AICTE name and Ashoka Chakra badge', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const branding = document.querySelector('.aicte-brand-logo');
    expect(branding).toBeTruthy();
    expect(branding.getAttribute('href')).toBe('/');
    expect(branding.textContent).toContain('अखिल भारतीय तकनीकी शिक्षा परिषद');
    expect(branding.textContent).toContain('ALL INDIA COUNCIL FOR TECHNICAL EDUCATION');
    expect(branding.textContent).toContain('Statutory Body · Ministry of Education, Government of India');

    const emblem = document.querySelector('.aicte-emblem-badge svg.ashoka-chakra-svg');
    expect(emblem).toBeTruthy();
  });

  it('verifies that the legacy utility top bar has been cleanly removed', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const topBar = document.querySelector('.gov-top-bar');
    expect(topBar).toBeNull();
  });

  it('renders all 4 simplified primary navigation links with smooth anchor destinations and confirms Zonal Bureaus removal', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const desktopNav = document.querySelector('nav.aicte-nav-links');
    expect(desktopNav).toBeTruthy();

    const expectedLinks = [
      { text: 'APH Norms', href: '#norms' },
      { text: 'Innovations', href: '#pillars' },
      { text: 'Bank Network', href: '#banks' },
      { text: 'SOP Workflow', href: '#workflow' },
    ];

    expectedLinks.forEach(({ text, href }) => {
      const link = desktopNav.querySelector(`a[href="${href}"]`);
      expect(link).toBeTruthy();
      expect(link.textContent.trim()).toBe(text);
    });

    // Confirm Zonal Bureaus section is completely removed from the landing page
    expect(container.querySelector('#bureaus')).toBeNull();
    expect(desktopNav.querySelector('a[href="#bureaus"]')).toBeNull();
  });

  it('renders a single primary Portal Sign In action on the right', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const actions = document.querySelector('.aicte-nav-actions');
    expect(actions).toBeTruthy();

    const signInLink = actions.querySelector('a[href="/login"]');
    expect(signInLink).toBeTruthy();
    expect(signInLink.textContent).toContain('Portal Sign In');
    expect(signInLink.classList.contains('btn-aicte-primary')).toBe(true);

    // Verify there is only a single action button on the navbar
    const actionLinks = actions.querySelectorAll('a');
    expect(actionLinks.length).toBe(1);
  });

  it('renders the 2-tier portal login gateway with instant demo login for Institution and Council', async () => {
    const actor = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>
    );

    // Verify Gateway Heading and Cards
    expect(screen.getByText('Select Authorized Access Portal')).toBeTruthy();
    expect(screen.getByText('Institution Portal Login')).toBeTruthy();
    expect(screen.getByText('Council & Reviewer Portal Login')).toBeTruthy();

    // Verify Demo Buttons
    const instDemoBtn = screen.getByRole('button', { name: /Institution Demo Login/i });
    const councilDemoBtn = screen.getByRole('button', { name: /Council Portal Demo Login/i });
    expect(instDemoBtn).toBeTruthy();
    expect(councilDemoBtn).toBeTruthy();

    // Click Institution Demo Login -> opens Institution Dashboard
    await actor.click(instDemoBtn);
    expect(await screen.findByText('Good day')).toBeTruthy();
    expect(screen.getByText('INSTITUTION OVERVIEW')).toBeTruthy();
  });

  it('manages the mobile menu drawer: toggle, keyboard Escape dismissal, and link click closure', async () => {
    const actor = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const toggle = screen.getByRole('button', { name: /navigation menu/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    const drawer = document.getElementById('mobile-navigation-drawer');
    expect(drawer).toBeTruthy();
    expect(drawer.classList.contains('open')).toBe(false);

    // Open mobile menu
    await actor.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(drawer.classList.contains('open')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    // Drawer should have all 4 navigation links and actions
    const mobileLinks = drawer.querySelectorAll('.aicte-mobile-nav-item');
    expect(mobileLinks.length).toBe(4);

    // Press Escape to dismiss
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(drawer.classList.contains('open')).toBe(false);
    expect(document.body.style.overflow).toBe('');

    // Reopen and click a link to test navigation auto-close
    await actor.click(toggle);
    expect(drawer.classList.contains('open')).toBe(true);

    const firstMobileLink = mobileLinks[0];
    await actor.click(firstMobileLink);
    expect(drawer.classList.contains('open')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('PART 3 — Hero Section UI Redesign', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the left column with eyebrow, main heading, Hindi subtitle, and purpose-driven description', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const heroSection = container.querySelector('.aicte-hero-section');
    expect(heroSection).toBeTruthy();

    // Compact eyebrow
    const eyebrow = heroSection.querySelector('.hero-eyebrow');
    expect(eyebrow).toBeTruthy();
    expect(eyebrow.textContent).toContain('AICTE Institutional Security Deposit Portal');

    // Main heading
    const heading = screen.getByRole('heading', { level: 1, name: /Institutional Security Deposit & FDR Management Portal/i });
    expect(heading).toBeTruthy();

    // Hindi subtitle
    const hindiSubhead = heroSection.querySelector('.hero-hindi-subhead');
    expect(hindiSubhead).toBeTruthy();
    expect(hindiSubhead.textContent).toContain('अखिल भारतीय तकनीकी शिक्षा परिषद — राष्ट्रीय संयुक्त सावधि जमा रसीद प्रबंधन प्रणाली');

    // Portal purpose description
    const subhead = heroSection.querySelector('.hero-subhead');
    expect(subhead).toBeTruthy();
    expect(subhead.textContent).toMatch(/security deposits|Fixed Deposit Receipts|verification workflows|maturity schedules/i);
  });

  it('renders two primary CTA buttons and restrained secondary APH deposit norms link', async () => {
    const actor = userEvent.setup();
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const heroSection = container.querySelector('.aicte-hero-section');
    const ctaRow = heroSection.querySelector('.hero-cta-row');
    expect(ctaRow).toBeTruthy();

    const signInBtn = ctaRow.querySelector('a[href="/login"]');
    expect(signInBtn).toBeTruthy();
    expect(signInBtn.textContent).toContain('Sign In to Portal');

    const registerBtn = ctaRow.querySelector('a[href="/register"]');
    expect(registerBtn).toBeTruthy();
    expect(registerBtn.textContent).toContain('Register Institution');

    // Restrained secondary link to APH norms
    const secondaryLink = heroSection.querySelector('.hero-secondary-link');
    expect(secondaryLink).toBeTruthy();
    expect(secondaryLink.getAttribute('href')).toBe('#norms');
    expect(secondaryLink.textContent).toContain('View APH Deposit Norms');

    // Click secondary link
    await actor.click(secondaryLink);
    expect(window.location.hash).toBe('#norms');
  });

  it('renders four compact feature highlights without unsupported regulatory claims', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const featureItems = container.querySelectorAll('.hero-features-grid .hero-feature-item');
    expect(featureItems.length).toBe(4);

    const labels = Array.from(featureItems).map((item) => item.textContent.trim());
    expect(labels).toContain('Joint FDR Record Management');
    expect(labels).toContain('Bank Verification Workflow');
    expect(labels).toContain('Duplicate-Document Checks');
    expect(labels).toContain('Maturity & Renewal Monitoring');
  });

  it('renders the official State Emblem of India (Ashok Stambh) monument with Satyameva Jayate, Government of India identification, and Tricolor background, and verifies footer removal', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    // Sovereign Ashok Stambh Monument Showcase
    const stambhMonument = container.querySelector('.sovereign-stambh-monument');
    expect(stambhMonument).toBeTruthy();

    // Official State Emblem of India images (featured monument + background watermark)
    const stambhImgs = container.querySelectorAll('.official-ashok-stambh-img');
    expect(stambhImgs.length).toBeGreaterThanOrEqual(2);

    // Sacred Motto in Devanagari
    const motto = container.querySelector('.stambh-caption-motto');
    expect(motto).toBeTruthy();
    expect(motto.textContent).toContain('सत्यमेव जयते');

    // Official Emblem and Government of India Identification
    const title = container.querySelector('.stambh-caption-title');
    expect(title).toBeTruthy();
    expect(title.textContent).toContain('STATE EMBLEM OF INDIA');

    const gov = container.querySelector('.stambh-caption-gov');
    expect(gov).toBeTruthy();
    expect(gov.textContent).toContain('Government of India');
    expect(gov.textContent).toContain('AICTE');

    // Background Ashok Stambh Watermark in Hero
    const watermark = container.querySelector('.hero-stambh-watermark');
    expect(watermark).toBeTruthy();
    expect(watermark.querySelector('.official-ashok-stambh-img')).toBeTruthy();

    // Verify footer requested for removal is completely gone
    expect(container.querySelector('.aicte-site-footer')).toBeNull();
    expect(container.querySelector('#contact')).toBeNull();
  });
});

describe('PART 4 — Statistics and APH Norms UI Redesign', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the clean statistics grid with honest statutory benchmark parameters and administrative notice', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const metricsSection = container.querySelector('.sovereign-metrics-section');
    expect(metricsSection).toBeTruthy();

    const heading = screen.getByRole('heading', { level: 2, name: /National Regulatory Reference Parameters/i });
    expect(heading).toBeTruthy();

    const cards = metricsSection.querySelectorAll('.metric-card-clean');
    expect(cards.length).toBe(4);

    // Card 1: Statutory Range
    expect(cards[0].textContent).toContain('Statutory Range');
    expect(cards[0].textContent).toContain('₹15L – ₹100L');
    expect(cards[0].textContent).toContain('Deposit Quantum Range');

    // Card 2: Zonal Jurisdiction
    expect(cards[1].textContent).toContain('Zonal Jurisdiction');
    expect(cards[1].textContent).toContain('10 Bureaus');
    expect(cards[1].textContent).toContain('Regional Jurisdictions');

    // Card 3: Mandatory Custody
    expect(cards[2].textContent).toContain('Mandatory Custody');
    expect(cards[2].textContent).toContain('8 – 10 Years');
    expect(cards[2].textContent).toContain('Statutory Custody Period');

    // Card 4: Verification Criteria (Consistency Checks)
    expect(cards[3].textContent).toContain('Verification Criteria');
    expect(cards[3].textContent).toContain('6 Vectors');
    expect(cards[3].textContent).toContain('Consistency Checks');

    // Administrative disclaimer note
    const notice = metricsSection.querySelector('.metrics-disclaimer-note');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('Administrative Notice');
    expect(notice.textContent).toContain('statutory reference parameters');

    // Verify absence of fabricated live metrics
    expect(metricsSection.textContent).not.toContain('14,520');
    expect(metricsSection.textContent).not.toContain('₹4,200 Cr');
    expect(metricsSection.textContent).not.toContain('99.4% Automated');
  });

  it('renders the structured APH Norms section with consistent program cards, metadata fields, and handbook reference', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const normsSection = container.querySelector('#norms');
    expect(normsSection).toBeTruthy();
    expect(normsSection.getAttribute('aria-labelledby')).toBe('norms-heading');

    const heading = screen.getByRole('heading', { level: 2, name: /Approval Process Handbook \(APH\) Deposit Norms/i });
    expect(heading).toBeTruthy();

    const normCards = normsSection.querySelectorAll('.norm-card-structured');
    expect(normCards.length).toBe(4);

    // Norm 1: Engineering & Technology
    expect(normCards[0].textContent).toContain('APH Ch. I · Sec 1.4');
    expect(normCards[0].textContent).toContain('100 Lakhs');
    expect(normCards[0].textContent).toContain('Engineering & Technology Institutions');
    expect(normCards[0].textContent).toContain('10 Years Mandatory Joint Lien');
    expect(normCards[0].textContent).toContain('Regional Officer, AICTE & Sponsoring Trust');

    // Norm 2: Management & MCA
    expect(normCards[1].textContent).toContain('APH Ch. II · Sec 2.3');
    expect(normCards[1].textContent).toContain('50 Lakhs');
    expect(normCards[1].textContent).toContain('Management (MBA/PGDM) & MCA');
    expect(normCards[1].textContent).toContain('10 Years Mandatory Joint Lien');
    expect(normCards[1].textContent).toContain('RBI Scheduled Commercial Banks');

    // Norm 3: Pharmacy, Architecture & Applied Arts
    expect(normCards[2].textContent).toContain('APH Ch. III · Sec 3.2');
    expect(normCards[2].textContent).toContain('35 Lakhs');
    expect(normCards[2].textContent).toContain('Pharmacy, Architecture & Applied Arts');
    expect(normCards[2].textContent).toContain('8 Years Mandatory Joint Lien');

    // Norm 4: Diploma & Polytechnic
    expect(normCards[3].textContent).toContain('APH Ch. IV · Sec 4.1');
    expect(normCards[3].textContent).toContain('25 Lakhs');
    expect(normCards[3].textContent).toContain('Diploma & Polytechnic Institutes');
    expect(normCards[3].textContent).toContain('8 Years Mandatory Joint Lien');

    // Dedicated Handbook Reference Panel
    const refPanel = normsSection.querySelector('.aph-source-reference-panel');
    expect(refPanel).toBeTruthy();
    expect(refPanel.textContent).toContain('AICTE Approval Process Handbook (APH 2024–2027)');
    expect(refPanel.textContent).toContain('Section 10, AICTE Act 1987');
    expect(refPanel.textContent).toContain('Joint Fixed Deposit Receipt (FDR)');
    expect(refPanel.textContent).toContain('Women, Persons with Disabilities (PwD)');
  });

  it('renders the 5 Core Compliance Safeguards section with distinctive cards, 2-digit indices, escalation ladder, and Indic OCR matrix', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const safeguardsSection = container.querySelector('#pillars');
    expect(safeguardsSection).toBeTruthy();
    expect(safeguardsSection.getAttribute('aria-labelledby')).toBe('pillars-heading');

    // Section introduction
    expect(safeguardsSection.querySelector('#pillars-heading').textContent).toBe('5 Core Compliance Safeguards');
    expect(safeguardsSection.textContent).toContain('SYSTEM ARCHITECTURE & SAFEGUARDS');
    expect(safeguardsSection.textContent).toContain('Multi-signal verification mechanisms designed to detect discrepancies, prevent duplicate pledging, and enforce statutory tenure.');

    const cards = safeguardsSection.querySelectorAll('.pillar-card-elevated');
    expect(cards.length).toBe(5);

    // Safeguard 01: Trust Score
    expect(cards[0].querySelector('.pillar-num').textContent).toBe('01');
    expect(cards[0].querySelector('.pillar-category-tag').textContent).toBe('INTEGRITY SCORING');
    expect(cards[0].querySelector('.pillar-card-title').textContent).toBe('Explainable FDR Trust Score');
    expect(cards[0].textContent).toContain('Combines six consistency signals');
    expect(cards[0].textContent).toContain('0–100 review-priority indicator');

    // Safeguard 02: Bank QR & Verification
    expect(cards[1].querySelector('.pillar-num').textContent).toBe('02');
    expect(cards[1].querySelector('.pillar-category-tag').textContent).toBe('BANK INTEGRATION');
    expect(cards[1].querySelector('.pillar-card-title').textContent).toBe('Bank QR & Verification Workflow');
    expect(cards[1].textContent).toContain('certificate QR-code processing');
    expect(cards[1].textContent).toContain('protection against untrusted domains');

    // Safeguard 03: Cryptographic Duplicate Shield
    expect(cards[2].querySelector('.pillar-num').textContent).toBe('03');
    expect(cards[2].querySelector('.pillar-category-tag').textContent).toBe('ANTI-COLLUSION');
    expect(cards[2].querySelector('.pillar-card-title').textContent).toBe('Cryptographic Duplicate Shield');
    expect(cards[2].textContent).toContain('Helps detect potential double-pledging');
    expect(cards[2].textContent).toContain('SHA-256 document fingerprints');

    // Safeguard 04: Maturity Escalation Ladder (Wider card)
    expect(cards[3].classList.contains('pillar-card-wide')).toBe(true);
    expect(cards[3].querySelector('.pillar-num').textContent).toBe('04');
    expect(cards[3].querySelector('.pillar-category-tag').textContent).toBe('LIFECYCLE MONITORING');
    expect(cards[3].querySelector('.pillar-card-title').textContent).toBe('Maturity Escalation Ladder');
    expect(cards[3].textContent).toContain('90-day, 30-day, and 7-day alerts');
    expect(cards[3].textContent).toContain('Indian Standard Time');
    expect(cards[3].querySelector('.pillar-stages-track')).toBeTruthy();
    expect(cards[3].textContent).toContain('T-90 DAYS');
    expect(cards[3].textContent).toContain('T-30 DAYS');
    expect(cards[3].textContent).toContain('T-7 DAYS');
    expect(cards[3].textContent).toContain('OVERDUE');

    // Safeguard 05: Indic OCR Processing (Wider card)
    expect(cards[4].classList.contains('pillar-card-wide')).toBe(true);
    expect(cards[4].querySelector('.pillar-num').textContent).toBe('05');
    expect(cards[4].querySelector('.pillar-category-tag').textContent).toBe('DOCUMENT AI PIPELINE');
    expect(cards[4].querySelector('.pillar-card-title').textContent).toBe('Multilingual Indic OCR Processing');
    expect(cards[4].textContent).toContain("Supports the project's planned and implemented OCR workflows");
    expect(cards[4].textContent).toContain('23 scheduled languages');
    expect(cards[4].textContent).toContain('Sarvam Doc-AI pipeline');
    expect(cards[4].querySelector('.pillar-languages-panel')).toBeTruthy();
    expect(cards[4].textContent).toContain('Hindi (हिन्दी)');
    expect(cards[4].textContent).toContain('Tamil (தமிழ்)');
  });

  it('renders the Integrated Banking Network section with interactive search, bank cards, and verification framework', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const banksSection = container.querySelector('#banks');
    expect(banksSection).toBeTruthy();
    expect(banksSection.getAttribute('aria-labelledby')).toBe('banks-heading');

    // Section introduction
    expect(banksSection.querySelector('#banks-heading').textContent).toBe('Integrated Banking Network');
    expect(banksSection.textContent).toContain('BANKING ECOSYSTEM');
    expect(banksSection.textContent).toContain('Second Schedule of the Reserve Bank of India Act, 1934');

    // Initial 8 banks rendering
    let bankCards = banksSection.querySelectorAll('.bank-partner-card');
    expect(bankCards.length).toBe(8);

    // Featured bank treatment for State Bank of India
    const sbiCard = bankCards[0];
    expect(sbiCard.textContent).toContain('State Bank of India');
    expect(sbiCard.textContent).toContain('भारतीय स्टेट बैंक');
    expect(sbiCard.textContent).toContain('SBIN');
    expect(sbiCard.textContent).toContain('Lead Depository');
    expect(sbiCard.classList.contains('bank-partner-card-featured')).toBe(true);

    // Verify search input interaction
    const searchInput = banksSection.querySelector('#bank-search-input');
    expect(searchInput).toBeTruthy();

    // Search for "Baroda"
    fireEvent.change(searchInput, { target: { value: 'Baroda' } });
    bankCards = banksSection.querySelectorAll('.bank-partner-card');
    expect(bankCards.length).toBe(1);
    expect(bankCards[0].textContent).toContain('Bank of Baroda');
    expect(bankCards[0].textContent).toContain('BARB');

    // Search for IFSC code "PUNB"
    fireEvent.change(searchInput, { target: { value: 'PUNB' } });
    bankCards = banksSection.querySelectorAll('.bank-partner-card');
    expect(bankCards.length).toBe(1);
    expect(bankCards[0].textContent).toContain('Punjab National Bank');

    // Search for non-existent bank -> empty state
    fireEvent.change(searchInput, { target: { value: 'NonExistentBankName' } });
    expect(banksSection.querySelectorAll('.bank-partner-card').length).toBe(0);
    const emptyState = banksSection.querySelector('.banks-empty-state');
    expect(emptyState).toBeTruthy();
    expect(emptyState.textContent).toContain('No Scheduled Banks Found');
    expect(emptyState.textContent).toContain('NonExistentBankName');

    // Reset search via empty state button
    const clearBtn = emptyState.querySelector('.banks-empty-reset-btn');
    expect(clearBtn).toBeTruthy();
    fireEvent.click(clearBtn);

    // All 8 banks restored
    expect(banksSection.querySelectorAll('.bank-partner-card').length).toBe(8);

    // Verification Framework Panel
    const verifPanel = banksSection.querySelector('.banks-verification-panel');
    expect(verifPanel).toBeTruthy();
    expect(verifPanel.textContent).toContain('Dual-Track FDR Verification & Bank Confirmation Protocol');
    expect(verifPanel.textContent).toContain('Bank & Branch Identification');
    expect(verifPanel.textContent).toContain('Multi-Signal Data Cross-Check');
    expect(verifPanel.textContent).toContain('QR-Code Verification');
    expect(verifPanel.textContent).toContain('Written Branch Confirmation Workflow');

    // Explicit disclaimer
    expect(verifPanel.textContent).toContain('Regulatory Disclaimer');
    expect(verifPanel.textContent).toContain('An automated field match does not constitute legal proof of authenticity');

    // Compliance Notice
    const complianceNotice = banksSection.querySelector('.banks-statutory-notice');
    expect(complianceNotice).toBeTruthy();
    expect(complianceNotice.textContent).toContain('Deposits drawn from co-operative credit societies');
  });
});
