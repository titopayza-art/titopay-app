(function adminWorkspace() {
  if (!document.body.classList.contains('is-dashboard')) return;
  document.querySelectorAll('main table').forEach(table=>{
    const headings=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row=>{
      [...row.cells].forEach((cell,index)=>{if(cell.colSpan===1&&headings[index])cell.dataset.label=headings[index];});
    });
  });
  const links=[...document.querySelectorAll('[data-workspace]')];
  const ids=['exports','support-chat','ticket-desk','ticket-archive','careers','website-submissions','create-ticket','staff'];
  const panels=ids.map(id=>document.getElementById(id)).filter(Boolean);
  const search=document.getElementById('portal-search');
  const feedback=document.getElementById('search-feedback');
  const status=document.getElementById('record-status');
  const type=document.getElementById('record-type');
  const filters=document.querySelector('.workspace-filters');
  const searchWrap=document.querySelector('.portal-search');
  const heading=document.querySelector('header h1');
  const stats=document.querySelector('.stats');
  const scope=document.querySelector('.summary-scope');
  const toolbar=document.createElement('div');toolbar.className='workspace-toolbar';
  if(searchWrap){searchWrap.before(toolbar);toolbar.append(searchWrap);}
  if(filters)toolbar.append(filters);
  const table=document.querySelector('#website-submissions table');
  const typeIndex=table?[...table.querySelectorAll('thead th')].findIndex(th=>th.textContent.trim().toLowerCase()==='type'):-1;
  const types=new Set();
  if(table&&typeIndex>=0)table.querySelectorAll('tbody tr').forEach(row=>{const cell=row.cells[typeIndex];if(cell&&row.cells.length>1)types.add(cell.textContent.trim());});
  if(type)types.forEach(value=>type.add(new Option(value,value)));
  let active='overview';
  const titles={'overview':'Operations dashboard','support-chat':'Live chat','ticket-desk':'Active tickets','ticket-archive':'Archived tickets','careers':'Careers','website-submissions':'Website enquiries','exports':'Downloads','create-ticket':'Create a ticket','staff':'Staff access'};
  function currentPanel(){return document.getElementById(active==='overview'?'website-submissions':active);}
  function applyFilters(){
    const panel=currentPanel();
    const records=panel?[...panel.querySelectorAll('.work-item, tbody tr')]:[];
    const query=(search?.value||'').trim().toLowerCase();
    let matches=0;
    records.forEach(record=>{
      const pills=[...record.querySelectorAll('.pill')].map(p=>p.textContent.trim().toLowerCase());
      const statusMatch=!status?.value||!record.classList.contains('work-item')||pills.includes(status.value);
      const typeMatch=!type?.value||record.tagName!=='TR'||record.cells[typeIndex]?.textContent.trim()===type.value;
      const visible=record.textContent.toLowerCase().includes(query)&&statusMatch&&typeMatch;
      record.hidden=!visible;if(visible)matches++;
    });
    if(feedback)feedback.textContent=records.length?`${matches} of ${records.length} loaded records shown.`:'';
    document.querySelectorAll('.portal-filter-empty').forEach(el=>el.remove());
    if(panel&&records.length&&matches===0){const empty=document.createElement('p');empty.className='portal-filter-empty';empty.setAttribute('role','status');empty.textContent='No records match these filters. Try a different search or reset the filters.';panel.append(empty);}
  }
  function setWorkspace(id){
    if(id!=='overview'&&!document.getElementById(id))id='overview';
    active=id;
    panels.forEach(panel=>{panel.hidden=panel.id!==(id==='overview'?'website-submissions':id);});
    if(stats)stats.hidden=id!=='overview';if(scope)scope.hidden=id!=='overview';
    if(heading)heading.textContent=titles[id]||'Operations dashboard';
    links.forEach(link=>{if(link.dataset.workspace===id)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
    const panel=currentPanel();
    const hasRecords=!!panel?.querySelector('.work-item, tbody tr');
    toolbar.hidden=!hasRecords;
    if(status){status.value='';status.disabled=!panel?.querySelector('.work-item');status.closest('label').hidden=status.disabled;}
    if(type){type.value='';type.disabled=!panel?.querySelector('table');type.closest('label').hidden=type.disabled;}
    if(search)search.value='';
    if(id==='create-ticket'&&panel instanceof HTMLDetailsElement)panel.open=true;
    try{sessionStorage.setItem('titopay_admin_workspace',id);}catch(_){}
    applyFilters();
  }
  document.addEventListener('click', event => {
    const link=event.target.closest('a[href^="#"]');
    if(!link || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const id=link.hash.slice(1);
    if(id!=='overview'&&!ids.includes(id)) return;
    event.preventDefault();
    if(location.hash!==link.hash) history.pushState(null,'',link.hash);
    setWorkspace(id);
    window.scrollTo({top:0,behavior:'instant'});
  });
  [search,status,type].filter(Boolean).forEach(control=>control.addEventListener(control===search?'input':'change',applyFilters));
  document.getElementById('reset-record-filters')?.addEventListener('click',()=>{if(search)search.value='';if(status)status.value='';if(type)type.value='';applyFilters();});
  window.addEventListener('hashchange',()=>setWorkspace(location.hash.slice(1)||'overview'));
  window.addEventListener('popstate',()=>setWorkspace(location.hash.slice(1)||'overview'));
  let saved='';try{saved=sessionStorage.getItem('titopay_admin_workspace')||'';}catch(_){}
  document.body.classList.add('portal-ready');setWorkspace(location.hash.slice(1)||saved||'overview');
})();
// Prevent accidental double clicks; allow normal form validation and submission.
document.querySelectorAll('form[method="post"]').forEach(form => {
  form.addEventListener('submit', event => {
    if (form.dataset.submitting === 'true') { event.preventDefault(); return; }
    form.dataset.submitting = 'true';
    const button = event.submitter;
    if (button) { button.disabled = true; button.textContent = 'Please wait…'; }
  });
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
