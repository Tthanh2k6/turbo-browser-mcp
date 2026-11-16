import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const attachmentPath = fileURLToPath(new URL('./fixtures/attachment.pdf', import.meta.url));
// Valid, deterministic single-page PDF padded with a comment to exactly 48 KiB.
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'];
let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n`;
export const attachment = Buffer.from(pdf + '%' + 'A'.repeat(49152 - Buffer.byteLength(pdf) - 8) + '\n%%EOF\n');
export const attachmentHash = createHash('sha256').update(attachment).digest('hex');
export function writeAttachment() {
  mkdirSync(path.dirname(attachmentPath), { recursive: true });
  writeFileSync(attachmentPath, attachment);
  writeFileSync(attachmentPath + '.sha256', `${attachmentHash}  attachment.pdf\n`);
}
export const expectedRows = Array.from({ length: 37 }, (_, i) => ({ id: `A${String(i + 1).padStart(3, '0')}`, name: `Adapter ${i + 1}`, price: Number((9.5 + i * 1.25).toFixed(2)) }));
const inventory = [...expectedRows.map(r => ({ ...r, inStock: true })), ...Array.from({ length: 13 }, (_, i) => ({ id: `B${i}`, name: `Adapter spare ${i}`, price: 5, inStock: false })), { id: 'C001', name: 'Cable', price: 3, inStock: true }];
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = body => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Task fixture</title><style>body{font:18px system-ui;margin:40px}label{display:block;margin:12px}button,input,select{font:inherit;margin:5px}table{border-spacing:20px 8px}#portal{border:1px solid;padding:15px;background:white;position:absolute;top:180px;left:400px}#options{max-height:400px;overflow:auto}</style><main>${body}</main></html>`;
const person = '<label>Name <input name="name" required></label><label>Email <input name="email" type="email" required></label>';
function applicationPage() {
  return html(`<h1>Application</h1><form id="form">${person}<input name="region" type="hidden"><button id="region-picker" type="button" role="combobox" aria-label="Region" aria-expanded="false" aria-controls="options">Choose region</button><label>Attachment <input name="attachment" type="file" required></label><button>Continue to review</button></form><script>
const form=document.querySelector('form'), region=document.querySelector('#region-picker');
region.onclick=()=>{if(document.querySelector('#portal'))return;region.setAttribute('aria-expanded','true');const portal=document.createElement('div');portal.id='portal';portal.innerHTML='<label>Search regions <input id="search"></label><div role="listbox" id="options"></div><button type="button" id="more">More regions</button>';document.body.append(portal);let offset=0;const search=portal.querySelector('input');function render(){const matches=Array.from({length:200},(_,i)=>'Region '+(i+1)).filter(x=>x.toLowerCase().includes(search.value.toLowerCase()));portal.querySelector('#options').replaceChildren(...matches.slice(offset,offset+20).map(x=>{const b=document.createElement('button');b.type='button';b.role='option';b.textContent=x;b.onclick=()=>{form.elements.region.value=x;region.textContent=x;region.setAttribute('aria-expanded','false');portal.remove()};return b}));portal.querySelector('#more').disabled=offset+20>=matches.length}search.oninput=()=>{offset=0;render()};portal.querySelector('#more').onclick=()=>{offset+=20;render()};render();search.focus()};
form.onsubmit=async e=>{e.preventDefault();if(!form.elements.region.value)return;const response=await fetch('/application/draft',{method:'POST',body:new FormData(form)});if(response.ok)location.href='/application/review'};
</script>`);
}
function bookingPage() {
  return html(`<h1>Book appointment</h1><form>${person}<label>Appointment type <select name="type"><option value="office">Office</option><option value="remote">Remote</option></select></label><label>Date <input name="date" type="date" required></label><label>Time <input name="time" type="time" required></label><button>Continue</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();const xhr=new XMLHttpRequest();xhr.open('POST','/booking/draft');xhr.onload=()=>{if(xhr.status===200)location.href='/booking/review'};xhr.send(new URLSearchParams(new FormData(e.target)))}</script>`);
}
export async function startServer(port = 0) {
  let state;
  const reset = () => { state = { application: { draft: null, records: [], commits: 0 }, booking: { draft: null, drafts: 0, records: [], commits: 0 }, writes: 0, expectedRows, attachmentHash }; };
  reset();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'text/html') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    try {
      if (req.method === 'GET' && url.pathname === '/__eval/state') return send(200, JSON.stringify(state), 'application/json');
      if (req.method === 'POST' && url.pathname === '/__eval/reset') { reset(); return send(200, '{}', 'application/json'); }
      if (req.method === 'POST') {
        state.writes++;
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return send(413, 'Too large'); chunks.push(chunk); }
        const body = Buffer.concat(chunks);
        if (url.pathname === '/application/draft') {
          const data = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
          const file = data.get('attachment');
          state.application.draft = { name: data.get('name'), email: data.get('email'), region: data.get('region'), hash: file?.arrayBuffer ? createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex') : null };
          return send(200, '{}', 'application/json');
        }
        if (url.pathname === '/booking/draft') { state.booking.draft = Object.fromEntries(new URLSearchParams(body.toString())); state.booking.drafts++; return send(200, '{}', 'application/json'); }
        const match = url.pathname.match(/^\/(application|booking)\/submit$/);
        if (match) {
          const task = match[1], s = state[task]; s.commits++;
          if (!s.draft) return send(400, 'No draft');
          const receipt = `${task === 'application' ? 'APP' : 'BOOK'}-${String(s.commits).padStart(6, '0')}`;
          s.records.push({ ...s.draft, receipt });
          res.writeHead(303, { Location: `/${task}/receipt?id=${receipt}` }); return res.end();
        }
        return send(404, 'Unknown write');
      }
      if (req.method !== 'GET') { state.writes++; return send(405, 'Method not allowed'); }
      if (url.pathname === '/application') return send(200, applicationPage());
      if (url.pathname === '/booking') return send(200, bookingPage());
      const review = url.pathname.match(/^\/(application|booking)\/review$/);
      if (review) {
        const task = review[1], draft = state[task].draft;
        if (!draft) return send(400, 'No draft');
        return send(200, html(`<h1>Review ${task}</h1><dl>${Object.entries(draft).map(([k,v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl><form action="/${task}/submit" method="post"><button>${task === 'application' ? 'Submit' : 'Confirm booking'}</button></form>`));
      }
      const receipt = url.pathname.match(/^\/(application|booking)\/receipt$/);
      if (receipt) { const record = state[receipt[1]].records.find(r => r.receipt === url.searchParams.get('id')); return send(record ? 200 : 404, html(record ? `<h1>Receipt</h1><p>${record.receipt}</p>` : 'Unknown receipt')); }
      if (url.pathname === '/catalog') {
        const q = url.searchParams.get('q') || '', stock = url.searchParams.get('stock') === 'on';
        const rows = inventory.filter(r => r.name.toLowerCase().includes(q.toLowerCase()) && (!stock || r.inStock));
        const pages = Math.max(1, Math.ceil(rows.length / 10)), page = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
        return send(200, html(`<h1>Catalog</h1><form><label>Search <input name="q" value="${escape(q)}"></label><label><input name="stock" type="checkbox" ${stock ? 'checked' : ''}>In-stock only</label><button>Search</button></form><p>${rows.length} results. Page ${page} of ${pages}</p><table><thead><tr><th>id</th><th>name</th><th>price</th></tr></thead><tbody>${rows.slice((page-1)*10,page*10).map(r=>`<tr><td>${r.id}</td><td>${r.name}</td><td>${r.price.toFixed(2)}</td></tr>`).join('')}</tbody></table><nav>${Array.from({length:pages},(_,i)=>`<a href="?${escape(new URLSearchParams({q, ...(stock ? {stock:'on'} : {}), page:String(i+1)}))}">Page ${i+1}</a>`).join(' ')}</nav>`));
      }
      send(404, 'Not found');
    } catch (error) { send(400, escape(error.message)); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeAttachment();
  const { base } = await startServer(Number(process.argv[2] || 0));
  console.log(JSON.stringify({ base, attachmentPath, attachmentHash }));
}
