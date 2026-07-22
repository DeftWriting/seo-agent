export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Deft SEO Agent</title>
  <style>
    :root{color-scheme:light;--ink:#251c27;--muted:#746b75;--line:#ddd6dd;--paper:#fbfaf8;--card:#fff;--accent:#57324f;--wash:#f4edf2;--moss:#587053;--bad:#a44040}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,sans-serif}
    main{width:min(1100px,calc(100% - 32px));margin:0 auto;padding:56px 0 80px}header{max-width:720px;margin-bottom:36px}h1{font:600 clamp(38px,7vw,68px)/.98 Georgia,serif;letter-spacing:-.045em;margin:0 0 18px}h2{font:600 26px/1.15 Georgia,serif;margin:0}p{color:var(--muted)}
    .grid{display:grid;grid-template-columns:minmax(0,420px) minmax(0,1fr);gap:32px;align-items:start}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}.field{display:grid;gap:7px;margin-bottom:18px}label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}input,textarea{width:100%;border:1px solid var(--line);border-radius:6px;padding:12px 13px;background:#fff;color:var(--ink);font:inherit}textarea{min-height:110px;resize:vertical}input:focus,textarea:focus,button:focus{outline:3px solid #b998b2;outline-offset:2px}button{border:0;border-radius:6px;background:var(--accent);color:#fff;padding:12px 18px;font:700 14px/1 system-ui;cursor:pointer}button[disabled]{opacity:.55;cursor:not-allowed}.secondary{background:#eee8ec;color:var(--ink)}.actions{display:flex;gap:10px;flex-wrap:wrap}
    .flow{display:grid;gap:10px;margin-top:20px}.step{border:1px solid var(--line);border-radius:8px;padding:13px 15px;display:flex;align-items:center;gap:10px;background:#fff}.step::before{content:'○';color:var(--muted)}.step.active{border-color:#a8869f;background:var(--wash)}.step.active::before{content:'◉';color:var(--accent)}.step.done::before{content:'✓';color:var(--moss)}.step.failed{border-color:#d5a0a0}.step.failed::before{content:'!';color:var(--bad)}
    .log{height:230px;overflow:auto;margin-top:20px;background:#211d21;color:#ece7eb;border-radius:8px;padding:14px;font:12px/1.6 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap}.notice{margin-top:16px;padding:12px;border-radius:6px;background:#f3ead1;color:#5d4a1d;font-size:13px}.result{display:none;margin-top:32px}.result.ready{display:block}.article{margin-top:20px;padding:28px;background:#fff;border:1px solid var(--line);border-radius:10px;white-space:pre-wrap;font:17px/1.7 Georgia,serif;max-height:70vh;overflow:auto}
    @media(max-width:760px){main{padding-top:32px}.grid{grid-template-columns:1fr}}
  </style>
</head>
<body><main>
  <header><h1>Deft SEO Agent</h1><p>Research a site and topic, plan the article, draft sections in parallel with Deft, then run adversarial fact-checking and line editing before a final pass.</p></header>
  <section class="grid" id="workspace">
    <form class="card" id="run-form">
      <div class="field"><label for="url">Website URL</label><input id="url" name="url" type="url" required placeholder="https://example.com"></div>
      <div class="field"><label for="topic">Target topic or keyword</label><textarea id="topic" name="topic" required placeholder="What should the article cover?"></textarea></div>
      <button id="run-button">Generate article</button>
      <p id="form-note">API keys are read from the local Node process and never enter this page. Cost and elapsed time are reported in the log below when the run finishes — this tool is billed to your own keys, so nothing about spend is hidden.</p>
    </form>
    <div class="card"><h2>How the agent works</h2><div class="flow" id="flow">
      <div class="step" data-step="research">Research site</div><div class="step" data-step="plan">Plan article</div><div class="step" data-step="draft">Draft sections in parallel</div><div class="step" data-step="structural">Structural edit</div><div class="step" data-step="review">Fact-check, line edit &amp; final pass</div>
    </div><div class="notice" id="notice" hidden>Keep this tab open while the local agent works.</div><div class="log" id="log" role="log" aria-live="polite">Ready.</div></div>
  </section>
  <section class="result" id="result"><div class="actions"><button id="copy">Copy Markdown</button><button class="secondary" id="download">Download .md</button></div><pre class="article" id="article"></pre></section>
</main><script>
const csrfToken=__SEO_AGENT_CSRF_TOKEN__;const form=document.querySelector('#run-form'),button=document.querySelector('#run-button'),log=document.querySelector('#log'),notice=document.querySelector('#notice'),result=document.querySelector('#result'),article=document.querySelector('#article');let markdown='';
const labels={run_started:'Run started',step_started:'Started',step_progress:'Working',step_complete:'Complete',warning:'Warning',run_complete:'Article ready',run_failed:'Failed'};
function usd(n){return n<0.01&&n>0?'$'+n.toFixed(4):'$'+n.toFixed(2)}
function duration(ms){if(ms<1000)return ms+'ms';const s=ms/1000;if(s<60)return s.toFixed(1)+'s';const m=Math.floor(s/60);return m+'m'+Math.round(s%60).toString().padStart(2,'0')+'s'}
function costLines(cost){const lines=['Cost: '+usd(cost.totalUsd)+' total ('+usd(cost.openRouterUsd)+' OpenRouter + '+usd(cost.deftUsd)+' Deft) — '+duration(cost.elapsedMs)+' elapsed'];for(const step of cost.byStep){if(step.calls===0&&step.deftUsd===0&&step.ms===0)continue;lines.push('  '+step.step+': '+usd(step.usd+step.deftUsd)+', '+duration(step.ms)+' ('+step.calls+' call'+(step.calls===1?'':'s')+')')}return lines}
function addLog(event){const time=new Date(event.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});const text=event.message||event.error||labels[event.type]||event.type;log.textContent+='\n'+time+'  '+text;log.scrollTop=log.scrollHeight;if(event.step){const el=document.querySelector('[data-step="'+event.step+'"]');if(el){el.classList.toggle('active',event.type==='step_started'||event.type==='step_progress');el.classList.toggle('done',event.type==='step_complete');el.classList.toggle('failed',event.type==='run_failed');}}if(event.type==='run_complete'){markdown=event.result.markdown;article.textContent=markdown;result.classList.add('ready');notice.hidden=true;button.disabled=false;for(const line of costLines(event.result.cost))log.textContent+='\n'+line;log.scrollTop=log.scrollHeight;}if(event.type==='run_failed'){notice.hidden=true;button.disabled=false;if(event.partialCost){for(const line of costLines(event.partialCost))log.textContent+='\n'+line;log.scrollTop=log.scrollHeight;}}}
form.addEventListener('submit',async(e)=>{e.preventDefault();button.disabled=true;notice.hidden=false;log.textContent='Starting…';result.classList.remove('ready');document.querySelectorAll('.step').forEach(el=>el.className='step');try{const response=await fetch('/api/runs',{method:'POST',headers:{'content-type':'application/json','x-seo-agent-csrf':csrfToken},body:JSON.stringify({url:form.url.value,topic:form.topic.value})});const body=await response.json();if(!response.ok)throw new Error(body.error||'Could not start run');const source=new EventSource('/api/runs/'+body.runId+'/events');source.onmessage=(message)=>{const event=JSON.parse(message.data);addLog(event);if(event.type==='run_complete'||event.type==='run_failed')source.close()};source.onerror=()=>{addLog({type:'run_failed',error:'Progress connection closed.',at:new Date().toISOString()});source.close()};}catch(error){addLog({type:'run_failed',error:error instanceof Error?error.message:String(error),at:new Date().toISOString()});button.disabled=false;notice.hidden=true;}});
document.querySelector('#copy').onclick=()=>navigator.clipboard.writeText(markdown);
document.querySelector('#download').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([markdown],{type:'text/markdown'}));a.download='deft-seo-article.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),0)};
</script></body></html>`;
