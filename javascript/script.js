const STORAGE_KEY = 'pinkGreenTripPlannerV1';

let state = {
  trip: { name:'Đà Lạt Trip', start:'2026-04-13', end:'2026-04-16', people:4 },
  places: [
    {id:uid(),name:'Linh Lam Cafe',category:'Cà phê',address:'Đà Lạt',cost:100000,notes:'',map:'',date:null,time:null},
    {id:uid(),name:'Mongo Land',category:'Tham quan',address:'Đà Lạt',cost:250000,notes:'',map:'',date:null,time:null},
    {id:uid(),name:'Lẩu gà lá é',category:'Ăn uống',address:'Đà Lạt',cost:250000,notes:'',map:'',date:null,time:null}
  ]
};
let pendingDrop = null;

function uid(){ return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function $(id){ return document.getElementById(id); }
function money(n){ return Number(n||0).toLocaleString('vi-VN') + ' ₫'; }
function esc(s=''){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function localDate(iso){ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function datesBetween(start,end){
  const out=[], d=new Date(start+'T12:00:00'), last=new Date(end+'T12:00:00');
  while(d<=last){ out.push(d.toISOString().slice(0,10)); d.setDate(d.getDate()+1); }
  return out;
}
function save(){ localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); }
function load(){ try{ const x=JSON.parse(localStorage.getItem(STORAGE_KEY)); if(x?.trip&&Array.isArray(x.places)) state=x; }catch(e){} }

function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>t.classList.remove('show'),1800); }

function render(){
  const days=datesBetween(state.trip.start,state.trip.end);
  $('tripName').value=state.trip.name; $('startDate').value=state.trip.start; $('endDate').value=state.trip.end; $('people').value=state.trip.people;
  $('tripBadge').textContent=`${days.length} ngày • ${state.trip.people} người`;
  $('plannerTitle').textContent=state.trip.name || 'Các ngày của chuyến đi';

  const uns=state.places.filter(p=>!p.date);
  $('unscheduledCount').textContent=uns.length;
  $('unscheduledList').innerHTML=uns.map(placeCard).join('') || `<div class="empty-day">Chưa có địa điểm chờ xếp lịch.</div>`;

  $('daysContainer').innerHTML=days.map((date,i)=>{
    const items=state.places.filter(p=>p.date===date).sort((a,b)=>(a.time||'99:99').localeCompare(b.time||'99:99'));
    const total=items.reduce((s,p)=>s+Number(p.cost||0),0);
    return `<article class="day-column">
      <div class="day-head"><div class="day-no">DAY ${i+1}</div><h3>${localDate(date)}</h3></div>
      <div class="day-drop" data-date="${date}">${items.length?items.map(placeCard).join(''):`<div class="empty-day">Kéo địa điểm vào đây<br>rồi chọn thời gian</div>`}</div>
      <div class="day-total"><span>Chi phí ngày</span><strong>${money(total)}</strong></div>
    </article>`;
  }).join('');

  const scheduled=state.places.filter(p=>p.date);
  $('placeTotal').textContent=state.places.length;
  $('scheduledTotal').textContent=scheduled.length;
  $('costTotal').textContent=money(state.places.reduce((s,p)=>s+Number(p.cost||0),0));
  bindDrag();
  save();
}

function placeCard(p){
  return `<div class="place-card" draggable="true" data-id="${p.id}">
    <div class="place-top">
      <div><div class="place-name">${esc(p.name)}</div><div class="category">${esc(p.category)}</div></div>
      ${p.time?`<span class="time-chip">${esc(p.time)}</span>`:''}
    </div>
    <div class="place-meta">
      ${p.address?`📍 ${esc(p.address)}<br>`:''}
      <span class="cost">💰 ${money(p.cost)}</span>
      ${p.notes?`<br>📝 ${esc(p.notes)}`:''}
      ${p.map?`<br><a class="map-link" href="${esc(p.map)}" target="_blank">↗ Mở bản đồ / link</a>`:''}
    </div>
    <div class="card-actions">
      <button class="mini-btn" onclick="editPlace('${p.id}')">✎ Sửa</button>
      <button class="mini-btn" onclick="duplicatePlace('${p.id}')">⧉ Copy</button>
      ${p.date?`<button class="mini-btn" onclick="unschedule('${p.id}')">↩ Bỏ lịch</button>`:''}
      <button class="mini-btn" onclick="deletePlace('${p.id}')">× Xóa</button>
    </div>
  </div>`;
}

function bindDrag(){
  document.querySelectorAll('.place-card').forEach(card=>{
    card.addEventListener('dragstart',e=>{ e.dataTransfer.setData('text/plain',card.dataset.id); card.classList.add('dragging'); });
    card.addEventListener('dragend',()=>card.classList.remove('dragging'));
  });
  document.querySelectorAll('.day-drop, #unscheduledList').forEach(zone=>{
    zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over')});
    zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
    zone.addEventListener('drop',e=>{
      e.preventDefault(); zone.classList.remove('drag-over');
      const id=e.dataTransfer.getData('text/plain'), date=zone.dataset.date;
      if(!date){ const p=find(id); if(p){p.date=null;p.time=null;render();toast('Đã đưa về Chưa xếp lịch');} return; }
      pendingDrop={id,date}; const p=find(id); $('timePlaceName').textContent=p?.name||''; $('scheduleTime').value=p?.time||'09:00'; $('timeModal').classList.remove('hidden');
    });
  });
}
function find(id){return state.places.find(p=>p.id===id)}
function openPlaceModal(p=null){
  $('modalTitle').textContent=p?'Chỉnh sửa địa điểm':'Thêm địa điểm'; $('placeId').value=p?.id||'';
  $('placeName').value=p?.name||''; $('placeCategory').value=p?.category||'Tham quan'; $('placeCost').value=p?.cost||0;
  $('placeAddress').value=p?.address||''; $('placeNotes').value=p?.notes||''; $('placeMap').value=p?.map||'';
  $('placeModal').classList.remove('hidden');
}
function closePlaceModal(){$('placeModal').classList.add('hidden')}
window.editPlace=id=>openPlaceModal(find(id));
window.duplicatePlace=id=>{const p=find(id);if(!p)return;state.places.push({...p,id:uid(),name:p.name+' (copy)',date:null,time:null});render();toast('Đã tạo bản sao')};
window.unschedule=id=>{const p=find(id);if(p){p.date=null;p.time=null;render();}};
window.deletePlace=id=>{if(confirm('Xóa địa điểm này?')){state.places=state.places.filter(p=>p.id!==id);render();}};

$('placeForm').addEventListener('submit',e=>{
  e.preventDefault(); const id=$('placeId').value;
  const data={name:$('placeName').value.trim(),category:$('placeCategory').value,address:$('placeAddress').value.trim(),cost:Number($('placeCost').value||0),notes:$('placeNotes').value.trim(),map:$('placeMap').value.trim()};
  if(id){Object.assign(find(id),data)}else state.places.push({id:uid(),...data,date:null,time:null});
  closePlaceModal();render();toast(id?'Đã cập nhật':'Đã thêm địa điểm');
});
$('addPlaceBtn').onclick=()=>openPlaceModal();
$('closeModalBtn').onclick=$('cancelModalBtn').onclick=closePlaceModal;
$('closeTimeBtn').onclick=$('cancelTimeBtn').onclick=()=>{pendingDrop=null;$('timeModal').classList.add('hidden')};
$('confirmTimeBtn').onclick=()=>{
  if(!pendingDrop)return; const p=find(pendingDrop.id); if(p){p.date=pendingDrop.date;p.time=$('scheduleTime').value||'09:00'}
  pendingDrop=null;$('timeModal').classList.add('hidden');render();toast('Đã xếp lịch');
};
$('createTripBtn').onclick=()=>{
  const start=$('startDate').value,end=$('endDate').value;
  if(!start||!end||start>end){alert('Ngày bắt đầu/kết thúc chưa hợp lệ.');return}
  state.trip={name:$('tripName').value.trim()||'My Trip',start,end,people:Number($('people').value||1)};
  const valid=new Set(datesBetween(start,end)); state.places.forEach(p=>{if(p.date&&!valid.has(p.date)){p.date=null;p.time=null}});
  render();toast('Đã cập nhật chuyến đi');
};
$('resetBtn').onclick=()=>{if(confirm('Tạo chuyến mới? Dữ liệu hiện tại sẽ được xóa.')){localStorage.removeItem(STORAGE_KEY);location.reload()}};

function rowsForDate(date){
  return state.places.filter(p=>p.date===date).sort((a,b)=>(a.time||'99:99').localeCompare(b.time||'99:99'));
}
$('excelBtn').onclick=()=>{
  if(typeof XLSX==='undefined'){alert('Không tải được thư viện Excel. Hãy kiểm tra Internet.');return}
  const wb=XLSX.utils.book_new(), days=datesBetween(state.trip.start,state.trip.end);
  const aoa=[];
  const merges=[];
  const dayTitleRows=[];
  const headerRows=[];
  const totalRows=[];
  const separatorRows=[];

  // Main trip title
  aoa.push([state.trip.name,'','','','','','']);
  merges.push({s:{r:0,c:0},e:{r:0,c:6}});
  aoa.push([`${localDate(state.trip.start)} → ${localDate(state.trip.end)}  •  ${state.trip.people} người`,'','','','','','']);
  merges.push({s:{r:1,c:0},e:{r:1,c:6}});
  aoa.push(['','','','','','','']);

  days.forEach((d,i)=>{
    const titleRow=aoa.length;
    dayTitleRows.push(titleRow);
    aoa.push([`DAY ${i+1}  •  ${localDate(d)}`,'','','','','','']);
    merges.push({s:{r:titleRow,c:0},e:{r:titleRow,c:6}});

    const headerRow=aoa.length;
    headerRows.push(headerRow);
    aoa.push(['Thời gian','Nội dung','Địa điểm','Chi phí','Ghi chú','Địa chỉ','Map']);

    const rows=rowsForDate(d);
    rows.forEach(p=>aoa.push([
      p.time||'', p.category||'', p.name||'', Number(p.cost||0),
      p.notes||'', p.address||'', p.map||''
    ]));

    const totalRow=aoa.length;
    totalRows.push(totalRow);
    const total=rows.reduce((s,p)=>s+Number(p.cost||0),0);
    aoa.push(['','','TỔNG CHI PHÍ NGÀY',total,'','','']);

    // Coloured separator between days
    if(i<days.length-1){
      const sep=aoa.length;
      separatorRows.push(sep);
      aoa.push(['','','','','','','']);
      aoa.push(['','','','','','','']);
    }
  });

  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges']=merges;
  const green='2C5951', green2='597355', greenLight='DCEBE2';
  const pink='F2DCE2', pink2='F2BDD0', pinkDark='BF5079';
  const pale='FFF7F9', white='FFFFFF', ink='263833', borderColor='D9E1DC';
  const border={top:{style:'thin',color:{rgb:borderColor}},bottom:{style:'thin',color:{rgb:borderColor}},left:{style:'thin',color:{rgb:borderColor}},right:{style:'thin',color:{rgb:borderColor}}};

  const range=XLSX.utils.decode_range(ws['!ref']);
  for(let R=0;R<=range.e.r;R++){
    for(let C=0;C<=6;C++){
      const addr=XLSX.utils.encode_cell({r:R,c:C});
      if(!ws[addr]) ws[addr]={t:'s',v:''};
      ws[addr].s={
        font:{name:'Arial',sz:10,color:{rgb:ink}},
        alignment:{vertical:'center',wrapText:true},
        border:border,
        fill:{fgColor:{rgb:white}}
      };
    }
  }

  // Trip title
  ws['A1'].s={fill:{fgColor:{rgb:pink}},font:{name:'Arial',sz:20,bold:true,color:{rgb:green}},alignment:{horizontal:'center',vertical:'center'}};
  ws['A2'].s={fill:{fgColor:{rgb:pink}},font:{name:'Arial',sz:11,bold:true,color:{rgb:green2}},alignment:{horizontal:'center',vertical:'center'}};

  dayTitleRows.forEach((R,i)=>{
    for(let C=0;C<=6;C++){
      const a=XLSX.utils.encode_cell({r:R,c:C});
      ws[a].s={fill:{fgColor:{rgb:i%2===0?green:green2}},font:{name:'Arial',sz:14,bold:true,color:{rgb:white}},alignment:{horizontal:'center',vertical:'center'},border};
    }
  });
  headerRows.forEach(R=>{
    for(let C=0;C<=6;C++){
      const a=XLSX.utils.encode_cell({r:R,c:C});
      ws[a].s={fill:{fgColor:{rgb:pinkDark}},font:{name:'Arial',sz:10,bold:true,color:{rgb:white}},alignment:{horizontal:'center',vertical:'center',wrapText:true},border};
    }
  });

  // Body styling by locating rows between each header and total.
  headerRows.forEach((h,idx)=>{
    const t=totalRows[idx];
    for(let R=h+1;R<t;R++){
      for(let C=0;C<=6;C++){
        const a=XLSX.utils.encode_cell({r:R,c:C});
        ws[a].s={fill:{fgColor:{rgb:(R-h)%2?pale:'F5FAF7'}},font:{name:'Arial',sz:10,color:{rgb:ink}},alignment:{vertical:'center',wrapText:true},border};
      }
      const timeCell=XLSX.utils.encode_cell({r:R,c:0});
      ws[timeCell].s.font={name:'Arial',sz:10,bold:true,color:{rgb:green}};
      const costCell=XLSX.utils.encode_cell({r:R,c:3});
      ws[costCell].z='#,##0" ₫"';
      ws[costCell].s.alignment={horizontal:'right',vertical:'center'};
    }
  });

  totalRows.forEach(R=>{
    for(let C=0;C<=6;C++){
      const a=XLSX.utils.encode_cell({r:R,c:C});
      ws[a].s={fill:{fgColor:{rgb:greenLight}},font:{name:'Arial',sz:10,bold:true,color:{rgb:green}},alignment:{vertical:'center',wrapText:true},border};
    }
    ws[XLSX.utils.encode_cell({r:R,c:3})].z='#,##0" ₫"';
  });

  // Strong pink separator bands between days.
  separatorRows.forEach(R=>{
    for(let RR=R;RR<=R+1;RR++){
      for(let C=0;C<=6;C++){
        const a=XLSX.utils.encode_cell({r:RR,c:C});
        ws[a].s={fill:{fgColor:{rgb:RR===R?pink2:pink}},font:{color:{rgb:pink2}},alignment:{vertical:'center'}};
      }
    }
  });

  ws['!cols']=[{wch:12},{wch:18},{wch:28},{wch:16},{wch:35},{wch:32},{wch:38}];
  ws['!rows']=aoa.map((_,r)=>{
    if(r===0)return {hpt:32};
    if(r===1)return {hpt:22};
    if(dayTitleRows.includes(r))return {hpt:27};
    if(headerRows.includes(r))return {hpt:24};
    if(separatorRows.includes(r)||separatorRows.includes(r-1))return {hpt:8};
    return {hpt:34};
  });
  ws['!freeze']={xSplit:0,ySplit:3};
  XLSX.utils.book_append_sheet(wb,ws,'Trip Planner');

  // Keep a clean detail sheet for filtering/searching.
  const detail=[['Ngày','Thời gian','Nội dung','Địa điểm','Địa chỉ','Chi phí','Ghi chú','Map']];
  days.forEach(d=>rowsForDate(d).forEach(p=>detail.push([localDate(d),p.time,p.category,p.name,p.address,p.cost,p.notes,p.map])));
  const ws2=XLSX.utils.aoa_to_sheet(detail);
  ws2['!cols']=[{wch:13},{wch:10},{wch:16},{wch:25},{wch:30},{wch:15},{wch:35},{wch:35}];
  const r2=XLSX.utils.decode_range(ws2['!ref']);
  for(let C=0;C<=r2.e.c;C++){
    const a=XLSX.utils.encode_cell({r:0,c:C});
    ws2[a].s={fill:{fgColor:{rgb:green}},font:{bold:true,color:{rgb:white}},alignment:{horizontal:'center'},border};
  }
  for(let R=1;R<=r2.e.r;R++) for(let C=0;C<=r2.e.c;C++){
    const a=XLSX.utils.encode_cell({r:R,c:C}); if(!ws2[a]) continue;
    ws2[a].s={fill:{fgColor:{rgb:R%2?pale:'F5FAF7'}},font:{color:{rgb:ink}},alignment:{vertical:'center',wrapText:true},border};
    if(C===5) ws2[a].z='#,##0" ₫"';
  }
  ws2['!autofilter']={ref:ws2['!ref']};
  XLSX.utils.book_append_sheet(wb,ws2,'Trip Details');
  XLSX.writeFile(wb,`${state.trip.name.replace(/[^\wÀ-ỹ -]/g,'') || 'Trip'}-planner.xlsx`);
};

function periodForTime(t){
  const h=Number((t||'0:00').split(':')[0]);
  if(h<11) return ['SÁNG','☀'];
  if(h<14) return ['TRƯA',''];
  if(h<18) return ['CHIỀU',''];
  return ['TỐI','☾'];
}
function pdfPageHTML(date,dayNo){
  const rows=rowsForDate(date), groups=[];
  rows.forEach(p=>{
    const [label,icon]=periodForTime(p.time);
    let g=groups.find(x=>x.label===label);
    if(!g){g={label,icon,items:[]};groups.push(g)}
    g.items.push(p);
  });
  const total=rows.reduce((s,p)=>s+Number(p.cost||0),0);
  return `<section class="pdf-sheet">
    <div class="pdf-top">
      <div class="pdf-kicker">LỊCH TRÌNH DU LỊCH</div>
      <div class="pdf-trip">${esc(state.trip.name)}</div>
      <div class="pdf-day">DAY ${dayNo}</div>
      <div class="pdf-date">${localDate(date)}</div>
    </div>
    <div class="pdf-body">
      ${groups.map(g=>`<div class="pdf-period">
        <div class="pdf-period-title">${g.label} <span>${g.icon}</span></div>
        ${g.items.map(p=>`<div class="pdf-row">
          <div class="pdf-time">${esc(p.time||'')}</div>
          <div class="pdf-info">
            <div class="pdf-place">${esc(p.name)}</div>
            <div class="pdf-category">${esc(p.category)}${p.address?` • ${esc(p.address)}`:''}</div>
            ${p.notes?`<div class="pdf-note">${esc(p.notes)}</div>`:''}
          </div>
          <div class="pdf-cost">${p.cost?money(p.cost):''}</div>
        </div>`).join('')}
      </div>`).join('')}
      ${rows.length?'':`<div class="pdf-empty">Chưa có hoạt động cho ngày này.</div>`}
    </div>
    <div class="pdf-footer"><span>Chi phí ngày</span><strong>${money(total)}</strong></div>
  </section>`;
}

$('pdfBtn').onclick=async()=>{
  if(!window.jspdf || !window.html2canvas){alert('Không tải được thư viện PDF. Hãy kiểm tra Internet.');return}
  const {jsPDF}=window.jspdf, days=datesBetween(state.trip.start,state.trip.end);
  const host=document.createElement('div');
  host.className='pdf-render-host';
  host.innerHTML=days.map((d,i)=>pdfPageHTML(d,i+1)).join('');
  document.body.appendChild(host);
  try{
    await document.fonts.ready;
    const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});
    const pages=[...host.querySelectorAll('.pdf-sheet')];
    for(let i=0;i<pages.length;i++){
      if(i) doc.addPage();
      const canvas=await html2canvas(pages[i],{scale:2,backgroundColor:'#ffffff',useCORS:true,logging:false});
      const img=canvas.toDataURL('image/jpeg',0.94);
      doc.addImage(img,'JPEG',0,0,210,297,undefined,'FAST');
    }
    doc.save(`${state.trip.name.replace(/[^\wÀ-ỹ -]/g,'') || 'Trip'}-itinerary.pdf`);
  }finally{ host.remove(); }
};
load(); render();
