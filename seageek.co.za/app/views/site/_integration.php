<div class="integration" style="margin-top:clamp(40px,6vw,64px)" aria-label="How your systems connect to SeaGeek">
  <svg viewBox="0 0 1120 440" role="img" aria-labelledby="intTitle intDesc">
    <title id="intTitle">How a request travels through SeaGeek</title>
    <desc id="intDesc">Your server calls the SeaGeek API with your key. SeaGeek checks limits and credit, bills in rand, routes to a wholesale partner and reaches your customer. Status updates come back to your server as webhooks.</desc>
    <defs>
      <path id="p-req" d="M232 200 C 290 200, 300 200, 360 200"/>
      <path id="p-out1" d="M660 200 C 720 200, 720 84, 780 84"/>
      <path id="p-out2" d="M660 200 C 720 200, 720 148, 780 148"/>
      <path id="p-out3" d="M660 200 C 720 200, 720 212, 780 212"/>
      <path id="p-out4" d="M660 200 C 720 200, 720 276, 780 276"/>
      <path id="p-out5" d="M660 200 C 720 200, 720 340, 780 340"/>
      <path id="p-last" d="M960 212 C 990 212, 990 212, 1010 212"/>
      <path id="p-hook" d="M440 330 C 360 400, 200 400, 130 250"/>
    </defs>
    <g font-family="Urbanist, sans-serif">
      <text x="20" y="28" font-size="13" font-weight="600" fill="#7e959c">YOUR SYSTEMS</text>
      <text x="360" y="28" font-size="13" font-weight="600" fill="#7e959c">SEAGEEK</text>
      <text x="780" y="28" font-size="13" font-weight="600" fill="#7e959c">WHOLESALE PARTNERS</text>
      <text x="1010" y="28" font-size="13" font-weight="600" fill="#7e959c">YOUR CUSTOMER</text>

      <rect x="20" y="150" width="212" height="100" rx="12" fill="#04090c" stroke="rgba(150,200,210,.3)"/>
      <text x="40" y="186" font-size="17" font-weight="600" fill="#e6eff1">Your app or server</text>
      <text x="40" y="210" font-size="13.5" fill="#b4c6cb">POST /v1/sms/messages</text>
      <text x="40" y="230" font-size="13.5" fill="#b4c6cb">Authorization: Bearer sg_live_…</text>

      <rect x="360" y="52" width="300" height="300" rx="16" fill="#04090c" stroke="#5fe3cf" stroke-opacity=".6"/>
      <text x="382" y="86" font-size="18" font-weight="600" fill="#e6eff1">api.seageek.co.za</text>
      <g font-size="14" fill="#b4c6cb">
        <text x="382" y="122"><tspan fill="#5fe3cf" font-family="JetBrains Mono, monospace">1 </tspan>Check key, plan and rate limits</text>
        <text x="382" y="152"><tspan fill="#5fe3cf" font-family="JetBrains Mono, monospace">2 </tspan>Check credit and AI spend cap</text>
        <text x="382" y="182"><tspan fill="#5fe3cf" font-family="JetBrains Mono, monospace">3 </tspan>Price in rand, debit credit</text>
        <text x="382" y="212"><tspan fill="#5fe3cf" font-family="JetBrains Mono, monospace">4 </tspan>Route to best partner</text>
        <text x="382" y="242"><tspan fill="#5fe3cf" font-family="JetBrains Mono, monospace">5 </tspan>Fail over and refund if needed</text>
        <text x="382" y="272"><tspan fill="#5fe3cf" font-family="JetBrains Mono, monospace">6 </tspan>Log, meter and invoice</text>
        <text x="382" y="302"><tspan fill="#5fe3cf" font-family="JetBrains Mono, monospace">7 </tspan>Send status to your webhook</text>
      </g>
      <text x="382" y="334" font-size="12.5" fill="#7e959c">Sandbox keys stop at step 3: simulated, free</text>

      <?php $partnersRows = [['SMS networks', 84], ['WhatsApp (Meta)', 148], ['Email delivery', 212], ['Identity data', 276], ['AI models', 340]];
      foreach ($partnersRows as [$label, $y]): ?>
        <rect x="780" y="<?= $y - 22 ?>" width="180" height="44" rx="10" fill="#04090c" stroke="rgba(195,168,255,.3)"/>
        <text x="798" y="<?= $y + 5 ?>" font-size="14.5" fill="#e6eff1"><?= $label ?></text>
      <?php endforeach; ?>

      <rect x="1010" y="160" width="92" height="104" rx="18" fill="#04090c" stroke="rgba(150,200,210,.3)"/>
      <rect x="1040" y="176" width="32" height="56" rx="6" fill="none" stroke="#b4c6cb" stroke-width="1.6"/>
      <text x="1056" y="252" font-size="12.5" fill="#b4c6cb" text-anchor="middle">Phone, inbox</text>

      <text x="150" y="424" font-size="13" fill="#c3a8ff">Webhooks: delivered, read, inbound reply, check result</text>
    </g>
    <g class="wires">
      <use href="#p-req" class="wire hot"/><use href="#p-out1" class="wire"/><use href="#p-out2" class="wire"/><use href="#p-out3" class="wire hot"/><use href="#p-out4" class="wire"/><use href="#p-out5" class="wire"/><use href="#p-last" class="wire hot"/>
      <use href="#p-hook" class="wire" style="stroke:rgba(195,168,255,.45);stroke-dasharray:5 6"/>
    </g>
    <g>
      <?php foreach ([['p-req', 0], ['p-req', 1.1], ['p-out1', .6], ['p-out2', 1.3], ['p-out3', .9], ['p-out3', 2], ['p-out4', 1.6], ['p-out5', .3], ['p-last', 1.4]] as [$p, $b]): ?>
        <circle class="pkt" r="4"><animateMotion dur="2.2s" begin="<?= $b ?>s" repeatCount="indefinite" rotate="auto"><mpath href="#<?= $p ?>"/></animateMotion></circle>
      <?php endforeach; ?>
      <circle class="pkt back" r="4"><animateMotion dur="3s" begin=".5s" repeatCount="indefinite"><mpath href="#p-hook"/></animateMotion></circle>
      <circle class="pkt back" r="4"><animateMotion dur="3s" begin="2s" repeatCount="indefinite"><mpath href="#p-hook"/></animateMotion></circle>
    </g>
  </svg>
  <ol class="steps">
    <li><b>Sign up</b>Get a sandbox key in a minute. Nothing is sent or billed.</li>
    <li><b>Call the API</b>From your server, with your key, using any language.</li>
    <li><b>We route and bill</b>Best partner for each request, priced in rand from your credit.</li>
    <li><b>Hear back</b>Delivery, replies and results arrive at your webhook and in Desk.</li>
  </ol>
</div>
