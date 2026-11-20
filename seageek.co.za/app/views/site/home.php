<?php $ocean = true; ?>
<section class="hero" aria-label="Introduction">
  <div class="hero-card">
    <div class="rays" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div class="hero-word" aria-hidden="true">seageek</div>
    <canvas class="hero-canvas" data-ocean data-horizon="0.6" data-sharks="1" aria-hidden="true"></canvas>

    <div class="hero-content">
      <div>
        <p class="hero-meta">Launching 2027 · Johannesburg</p>
        <h1>Intelligence.<br><span class="accent">Connected.</span></h1>
      </div>
      <div class="hero-copy">
        <p>SMS, email, authentication, identity checks, WhatsApp, voice and AI through one South African API. Integrate once, pay in rand, get support in your time zone.</p>
        <div class="btn-row">
          <a class="btn btn-primary" href="/register">Start free</a>
          <a class="btn btn-ghost" href="/developers">API preview</a>
        </div>
      </div>
      <div class="signal-panel">
        <div class="signal">
          <div class="k">Products</div>
          <div class="v">11</div>
          <div class="d">APIs and Desk, one account</div>
        </div>
        <div class="signal">
          <div class="k">Starting price</div>
          <div class="v">R0</div>
          <div class="d">per month, Developer plan</div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="section" id="products">
  <div class="wrap">
    <div class="section-head">
      <h2>Products</h2>
      <p class="lead">Each product has its own API. They share one account, one set of keys, one bill and one webhook system. We release them in stages as supplier agreements and readiness checks are completed.</p>
    </div>

    <div class="products">
      <article class="product wide">
        <div class="product-top"><div class="product-icon"><?= icon('sms') ?></div><span class="when<?= in_array(Catalog::services()['sms']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['sms']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>SMS</h3>
        <p>Bulk, transactional and OTP messages with delivery receipts, scheduling, templates and sender IDs.</p>
        <ul><li>Bulk and transactional</li><li>OTP</li><li>Delivery receipts</li><li>Scheduling</li></ul>
      </article>
      <article class="product wide">
        <div class="product-top"><div class="product-icon"><?= icon('mail') ?></div><span class="when<?= in_array(Catalog::services()['mail']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['mail']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>Mail</h3>
        <p>Transactional and marketing email with templates, bounce handling, suppression lists and help setting up SPF, DKIM and DMARC.</p>
        <ul><li>Templates</li><li>Bounces</li><li>Suppression lists</li><li>Analytics</li></ul>
      </article>
      <article class="product">
        <div class="product-top"><div class="product-icon"><?= icon('auth') ?></div><span class="when<?= in_array(Catalog::services()['auth']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['auth']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>Auth</h3>
        <p>OTP, multi-factor, passkeys and passwordless sign-in, with rate limiting and risk checks.</p>
      </article>
      <article class="product">
        <div class="product-top"><div class="product-icon"><?= icon('notify') ?></div><span class="when<?= in_array(Catalog::services()['notify']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['notify']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>Notify</h3>
        <p>Web and mobile push with segments, scheduling, user preferences and fallback to SMS or email.</p>
      </article>
      <article class="product">
        <div class="product-top"><div class="product-icon"><?= icon('ai') ?></div><span class="when<?= in_array(Catalog::services()['ai']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['ai']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>AI</h3>
        <p>Chat and support agents that answer from your own knowledge base and hand over to a person when needed.</p>
      </article>
      <article class="product">
        <div class="product-top"><div class="product-icon"><?= icon('whatsapp') ?></div><span class="when<?= in_array(Catalog::services()['whatsapp']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['whatsapp']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>WhatsApp</h3>
        <p>WhatsApp Business Platform messaging with approved templates, a shared inbox and automated replies.</p>
      </article>
      <article class="product">
        <div class="product-top"><div class="product-icon"><?= icon('verify') ?></div><span class="when<?= in_array(Catalog::services()['verify']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['verify']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>Verify</h3>
        <p>Identity, document and business checks, plus PEP and sanctions screening, with an audit record of each check.</p>
      </article>
      <article class="product">
        <div class="product-top"><div class="product-icon"><?= icon('voice') ?></div><span class="when<?= in_array(Catalog::services()['voice']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['voice']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>Voice</h3>
        <p>Voice OTP, IVR menus, call routing, outbound calls and AI receptionists.</p>
      </article>
      <article class="product wide">
        <div class="product-top"><div class="product-icon"><?= icon('sign') ?></div><span class="when<?= in_array(Catalog::services()['sign']['status'] ?? 'planned', ['live','beta'], true) ? ' on' : '' ?>"><?= e(Catalog::statusLabel(Catalog::services()['sign']['status'] ?? 'planned') ?? 'Available') ?></span></div>
        <h3>Sign</h3>
        <p>Prepare documents, invite signers and run approvals, with an audit trail. Signers can be identity-checked first.</p>
      </article>
      <article class="product wide">
        <div class="product-top"><div class="product-icon"><?= icon('connect') ?></div><span class="when">Available</span></div>
        <h3>Connect</h3>
        <p>The layer under every product: API keys, webhooks, workflows, integrations, usage reports and SDKs.</p>
      </article>
    </div>
  </div>
</section>

<section class="section" id="platform">
  <div class="wrap">
    <div class="platform">
      <div>
        <h2>How it works</h2>
        <p class="lead" style="margin-top:16px">Your systems call one SeaGeek API. We send each request to a licensed upstream provider, and we can change providers without changing the API you use.</p>
        <ul class="feature-list">
          <li><b>One key for every product</b><span>Organisations, users, roles and API keys are managed in one place.</span></li>
          <li><b>Signed webhooks, safe retries</b><span>Every event is signed. Idempotency keys stop a retry from sending twice.</span></li>
          <li><b>A separate sandbox</b><span>Test keys and test data, with nothing delivered and nothing billed.</span></li>
          <li><b>Itemised usage in rand</b><span>Every metered request shows on your usage report, with alerts before you go over budget.</span></li>
        </ul>
      </div>

      <div class="code-window" data-tabs>
        <div class="code-head">
          <div class="tabs" role="tablist" aria-label="Code language">
            <button class="tab" role="tab" data-lang="curl" aria-selected="true">cURL</button>
            <button class="tab" role="tab" data-lang="node" aria-selected="false">Node.js</button>
            <button class="tab" role="tab" data-lang="python" aria-selected="false">Python</button>
          </div>
          <button class="copy-btn" type="button">Copy</button>
        </div>
        <div class="code-body">
<pre data-lang="curl"><span class="tok-c"># Send an OTP by SMS</span>
<span class="tok-f">curl</span> https://api.seageek.co.za/v1/sms/messages \
  -H <span class="tok-s">"Authorization: Bearer $SEAGEEK_KEY"</span> \
  -H <span class="tok-s">"Idempotency-Key: order-10294-otp"</span> \
  -d <span class="tok-s">'{
    "to": "+27821234567",
    "from": "SeaGeek",
    "body": "Your verification code is 482913"
  }'</span></pre>
<pre data-lang="node" hidden><span class="tok-k">import</span> { SeaGeek } <span class="tok-k">from</span> <span class="tok-s">"@seageek/node"</span>;

<span class="tok-k">const</span> sg = <span class="tok-k">new</span> <span class="tok-f">SeaGeek</span>(process.env.<span class="tok-p">SEAGEEK_KEY</span>);

<span class="tok-k">const</span> msg = <span class="tok-k">await</span> sg.sms.<span class="tok-f">send</span>({
  to: <span class="tok-s">"+27821234567"</span>,
  from: <span class="tok-s">"SeaGeek"</span>,
  body: <span class="tok-s">"Your verification code is 482913"</span>,
}, { idempotencyKey: <span class="tok-s">"order-10294-otp"</span> });</pre>
<pre data-lang="python" hidden><span class="tok-k">from</span> seageek <span class="tok-k">import</span> SeaGeek

sg = <span class="tok-f">SeaGeek</span>(os.environ[<span class="tok-s">"SEAGEEK_KEY"</span>])

msg = sg.sms.<span class="tok-f">send</span>(
    to=<span class="tok-s">"+27821234567"</span>,
    sender=<span class="tok-s">"SeaGeek"</span>,
    body=<span class="tok-s">"Your verification code is 482913"</span>,
    idempotency_key=<span class="tok-s">"order-10294-otp"</span>,
)</pre>
        </div>
        <div class="code-foot"><span>202 Accepted</span><span>Draft API. Details may change before launch.</span></div>
      </div>
    </div>

    <?php require APP_DIR . '/views/site/_integration.php'; ?>

    <div class="partners-block" id="partners">
      <div class="section-head">
        <h2>Upstream partners</h2>
        <p class="lead">These are the providers behind each channel. Where a channel has two, we can switch between them if one has problems. You deal only with SeaGeek.</p>
      </div>
      <div class="partners">
        <div class="partner"><div class="product-icon"><?= icon('sms') ?></div><h3>SMS</h3><div class="names">SMSMessenger, Iwin / Zephyr</div><p>Bulk, transactional and OTP delivery.</p></div>
        <div class="partner"><div class="product-icon"><?= icon('whatsapp') ?></div><h3>WhatsApp</h3><div class="names">360dialog, ChatReach</div><p>WhatsApp Business Platform access.</p></div>
        <div class="partner"><div class="product-icon"><?= icon('verify') ?></div><h3>KYC / AML</h3><div class="names">Teruza, VerifyNow</div><p>Identity checks and screening data.</p></div>
        <div class="partner"><div class="product-icon"><?= icon('mail') ?></div><h3>Email</h3><div class="names">Amazon SES</div><p>Transactional and bulk email.</p></div>
        <div class="partner"><div class="product-icon"><?= icon('ai') ?></div><h3>AI</h3><div class="names">Anthropic, OpenAI</div><p>Claude and GPT models for SeaGeek AI.</p></div>
        <div class="partner"><div class="product-icon"><?= icon('voice') ?></div><h3>Voice</h3><div class="names">Zephyr, Cloud Telecoms</div><p>Voice OTP, IVR and call routing.</p></div>
      </div>
      <p class="partners-note">Commercial agreements with these providers are being finalised and may change. Trademarks belong to their owners. Naming a provider here does not mean it endorses SeaGeek.</p>
    </div>
  </div>
</section>

<section class="section" id="industries">
  <div class="wrap">
    <div class="section-head">
      <h2>Who it's for</h2>
      <p class="lead">Businesses that need to message their customers and check who they are.</p>
    </div>
    <div class="industries">
      <div class="industry"><?= icon('bank', 'ic') ?><h3>Financial services</h3><p>Banks, insurers, lenders and payment providers that need sign-in security, notifications and compliance checks.</p><span class="uses">Auth, Verify, SMS, Mail</span></div>
      <div class="industry"><?= icon('cart', 'ic') ?><h3>Retail and e-commerce</h3><p>Order updates, customer support, sign-in and marketing messages.</p><span class="uses">SMS, WhatsApp, Notify, AI</span></div>
      <div class="industry"><?= icon('edu', 'ic') ?><h3>Education</h3><p>Schools, colleges and universities messaging students and processing applications.</p><span class="uses">Mail, SMS, Verify, Sign</span></div>
      <div class="industry"><?= icon('home', 'ic') ?><h3>Property</h3><p>Tenant messages, applicant screening and signed leases for landlords and student housing.</p><span class="uses">Verify, Sign, WhatsApp</span></div>
      <div class="industry"><?= icon('health', 'ic') ?><h3>Healthcare admin</h3><p>Appointment reminders and patient communication for clinics and practices.</p><span class="uses">SMS, Voice, Mail</span></div>
      <div class="industry"><?= icon('terminal', 'ic') ?><h3>Developers and SaaS</h3><p>Teams that want one supplier instead of a separate contract for every channel.</p><span class="uses">All products</span></div>
    </div>
  </div>
</section>

<section class="section" id="why">
  <div class="wrap">
    <div class="section-head">
      <h2>Why SeaGeek</h2>
      <p class="lead">The global platforms are big. We focus on what South African businesses need day to day.</p>
    </div>
    <ul class="why">
      <li><h3>One platform</h3><p>Every channel uses the same account, keys, conventions and documentation.</p></li>
      <li><h3>Rand pricing</h3><p>Prices and VAT invoices in ZAR, so exchange rates don't change your bill.</p></li>
      <li><h3>Local support</h3><p>A team in your time zone that knows local networks and regulations.</p></li>
      <li><h3>Published service levels</h3><p>A public status page with uptime and delivery figures.</p></li>
      <li><h3>Prepaid or on account</h3><p>Prepaid billing for smaller businesses, monthly invoices for larger ones.</p></li>
      <li><h3>Clear documentation</h3><p>Working examples and SDKs that follow the same patterns across products.</p></li>
      <li><h3>AI inside your messaging</h3><p>AI agents run in the same conversations as your SMS, WhatsApp and email.</p></li>
      <li><h3>More than one route</h3><p>Where contracts and the law allow, traffic can move between providers.</p></li>
    </ul>
  </div>
</section>

<?php require APP_DIR . '/views/site/_pricing.php'; ?>

<section class="section" id="trust">
  <div class="wrap">
    <div class="section-head">
      <h2>Security and compliance</h2>
      <p class="lead">Messaging and identity checks involve personal information. No product takes live customers until it has passed its security and operational checks.</p>
    </div>
    <div class="trust">
      <div class="trust-card">
        <h3>Security</h3>
        <ul class="check-grid">
          <li>Encryption in transit and at rest</li><li>Each customer's data kept separate</li>
          <li>Role-based access and audit logs</li><li>Signed webhooks</li>
          <li>Rate limits and abuse monitoring</li><li>Separate sandbox and production</li>
          <li>Tested backups</li><li>Regular penetration tests</li>
          <li>Reviews of admin access</li><li>A written incident response plan</li>
        </ul>
      </div>
      <div class="trust-card">
        <h3>Regulation</h3>
        <div class="reg-list">
          <div class="reg"><b>POPIA</b><span>Lawful processing, collecting only what's needed, set retention periods, data-subject requests and controls on cross-border transfers.</span></div>
          <div class="reg"><b>ICASA</b><span>Licensing assessed against the telecoms services we actually provide.</span></div>
          <div class="reg"><b>Consent</b><span>Opt-outs and suppression lists applied automatically. Customers agree to use messaging lawfully.</span></div>
          <div class="reg"><b>FIC Act</b><span>Verification products launch only with licensed data sources and legal sign-off.</span></div>
          <div class="reg"><b>AI</b><span>Models are tested before release, sensitive data is protected, and a person approves important decisions.</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="section" id="roadmap">
  <div class="wrap">
    <div class="section-head">
      <h2>Roadmap</h2>
      <p class="lead">We start with SMS, Mail and Auth, and add each channel once we can run it properly.</p>
    </div>
    <div class="roadmap">
      <div class="stop"><div class="when"><b>Q1 2027</b></div><div><h3>Foundation</h3><p>Company registration, core platform, developer portal, billing, and the first SMS and Mail releases.</p></div></div>
      <div class="stop"><div class="when"><b>Q2 2027</b></div><div><h3>Auth, Notify and AI</h3><p>Authentication APIs, push notifications and the first AI agents.</p></div></div>
      <div class="stop"><div class="when"><b>Q3 2027</b></div><div><h3>WhatsApp</h3><p>WhatsApp messaging, a shared customer inbox, and wider sales.</p></div></div>
      <div class="stop"><div class="when"><b>Q4 2027</b></div><div><h3>Verify</h3><p>First KYC and AML checks, once supplier agreements and legal review are done.</p></div></div>
      <div class="stop"><div class="when"><b>2028</b></div><div><h3>Voice, Sign and enterprise</h3><p>Voice and Sign APIs, more workflow features in Connect, and enterprise contracts.</p></div></div>
      <div class="stop"><div class="when"><b>2029</b></div><div><h3>Other African markets</h3><p>Expansion beyond South Africa and more AI products.</p></div></div>
    </div>
    <p class="roadmap-note">Dates depend on funding, supplier agreements, customer demand and regulatory approval.</p>
  </div>
</section>

<section class="section" id="startups"><div class="wrap">
  <div class="quote-cta" style="padding:clamp(22px,3vw,34px)">
    <div><b style="font-size:clamp(22px,3vw,30px);font-family:var(--font-display)">Build with us</b><span style="display:block;margin-top:6px">Startups get <?= zar((float) Settings::get('startup_credit'), 0) ?> of launch credit, the Startup plan free for <?= (int) Settings::get('startup_plan_months') ?> months and help from our engineers.</span></div>
    <a class="btn btn-primary" href="/startups">Apply for the startup programme</a>
  </div>
</div></section>
<section class="section" id="early-access">
  <div class="wrap">
    <div class="cta">
      <div>
        <h2>Start in sandbox today</h2>
        <p>Create an account and get a sandbox key in a minute. Build and test for free, then add credit to go live. No contract, no setup fee.</p>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-self:center"><a class="btn btn-primary" href="/register">Create a free account</a><a class="btn btn-ghost" href="/contact">Talk to us</a></div>
    </div>
  </div>
</section>
