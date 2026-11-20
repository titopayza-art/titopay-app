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
  <ul class="why why-3" style="margin-top:48px">
    <li><h3>Every channel, one inbox</h3><p>Website chat, your existing support mailbox, WhatsApp, website forms, the help centre and the API. Replies go back on the channel the customer used.</p></li>
    <li><h3>AI answers first</h3><p>SeaGeek AI answers from your help centre in the customer's language, any time of day, and hands over to a person when it should. You set a monthly spending cap.</p></li>
    <li><h3>Real email conversations</h3><p>Connect help@yourbusiness.co.za in minutes. Replies stay in one thread, quoted text is trimmed, attachments come through, and auto-replies are ignored.</p></li>
    <li><h3>Rules that do the sorting</h3><p>"If it mentions refund, make it urgent, assign it to me and skip the AI." Quiet tickets are solved for you, and customers are told.</p></li>
    <li><h3>Built for small teams</h3><p>See when a colleague is viewing or typing, get warned before you send a reply that clashes, merge duplicates, and attach files both ways.</p></li>
    <li><h3>AI drafts and summaries</h3><p>One click writes a reply for you to check, or sums up a long conversation as an internal note.</p></li>
    <li><h3>Help centre</h3><p>Your own public knowledge base at seageek.co.za/h/your-company, searchable, and the source the AI answers from.</p></li>
    <li><h3>Reports</h3><p>Tickets by day and channel, share answered by AI alone, median first-reply and solve times, ratings, and each person's workload.</p></li>
    <li><h3>Included in every plan</h3><p>Desk seats come with your SeaGeek plan, billed in rand with everything else. No separate help desk subscription in dollars.</p></li>
  </ul>
  <div style="margin-top:28px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn btn-primary" href="/register">Start free</a><a class="btn btn-ghost" href="/docs/desk">Desk API</a></div>
</div></section>
<style>@media (max-width:760px){.desk-demo{grid-template-columns:1fr!important}.desk-demo>div:first-child{border-right:0!important;border-bottom:1px solid var(--line)}}</style>
