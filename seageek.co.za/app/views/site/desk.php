<?php $h1 = 'Desk'; $meta = 'Customer service, included in every plan'; $lead = 'One inbox for chat, WhatsApp, email and web forms. An AI agent answers first and hands over to your team when it should.'; require APP_DIR . '/views/site/_pagehero.php'; ?>
<section class="section" style="padding-top:56px"><div class="wrap">
  <div class="panel" style="padding:0;overflow:hidden" aria-label="Example of the Desk inbox">
    <div style="display:grid;grid-template-columns:260px 1fr" class="desk-demo">
      <div style="border-right:1px solid var(--line);padding:14px">
        <?php foreach ([['Refund for order 10294', 'Thandi N.', 'WhatsApp', 'AI', 'violet'], ['Can I change my delivery date?', 'Pieter V.', 'Chat', 'Solved by AI', 'green'], ['Charged twice', 'Ayesha M.', 'Email', 'Handed over', 'amber'], ['Invoice copy please', 'Lerato K.', 'Web form', 'Open', 'blue']] as $i => [$s, $n, $c, $st, $col]): ?>
          <div style="padding:10px;border-radius:10px;margin-bottom:6px;<?= $i === 2 ? 'background:rgba(95,227,207,.08)' : '' ?>"><div style="font-size:14.5px;font-weight:600"><?= $s ?></div><div class="muted small"><?= $n ?> · <?= $c ?></div><span class="pill <?= $col ?>" style="margin-top:6px"><?= $st ?></span></div>
        <?php endforeach; ?>
      </div>
      <div style="padding:18px" class="thread">
        <div class="msg"><div class="who"><b>Ayesha M.</b><span>09:12</span></div><div class="body">Hi, I was charged twice for my order last night.</div></div>
        <div class="msg ai"><div class="who"><b>AI agent</b><span>09:12</span></div><div class="body">I'm sorry about that. Double charges need our billing team, so I've passed this to them with your order details. You'll get an email reply today.</div></div>
        <div class="msg system"><div class="body">Handed to a person: billing dispute</div></div>
        <div class="msg agent"><div class="who"><b>Sipho (Billing)</b><span>09:31</span></div><div class="body">Thanks Ayesha. I can see the duplicate payment and have refunded it. It reflects in 2 to 3 working days.</div></div>
      </div>
    </div>
  </div>
  <ul class="why" style="margin-top:48px;grid-template-columns:repeat(3,1fr)">
    <li><h3>Omnichannel inbox</h3><p>Website chat widget, WhatsApp, email forwarding, help centre form and API, threaded per customer.</p></li>
    <li><h3>AI agent with handover</h3><p>Answers from your help centre using Claude or GPT. Billing disputes, complaints, legal and security issues always go to people.</p></li>
    <li><h3>Help centre</h3><p>Your own public knowledge base at seageek.co.za/h/your-company, searchable and used to train the AI agent.</p></li>
    <li><h3>Views, priorities and targets</h3><p>Open, mine, pending, AI handling and overdue views. First-reply targets by priority with alerts.</p></li>
    <li><h3>Macros and AI drafts</h3><p>Saved replies that also set status, and one-click AI drafts your agents can edit.</p></li>
    <li><h3>Ratings and reporting</h3><p>Customers rate solved requests. See volume, AI-handled share and satisfaction for the last 30 days.</p></li>
  </ul>
  <div style="margin-top:28px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn btn-primary" href="/register">Start free</a><a class="btn btn-ghost" href="/docs/desk">Desk API</a></div>
</div></section>
<style>@media (max-width:760px){.desk-demo{grid-template-columns:1fr!important}.desk-demo>div:first-child{border-right:0!important;border-bottom:1px solid var(--line)}}</style>
