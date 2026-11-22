// Splits page text into overlapping chunks (spec 5.4). Shared by the page and the tests.
export function chunkText(pages,size,overlap){
  const out=[];overlap=Math.min(overlap,size-50);
  for(const p of pages){
    const text=p.text.replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();if(!text)continue;
    let start=0;
    while(start<text.length){
      let end=Math.min(start+size,text.length);
      if(end<text.length){const win=text.slice(start+Math.floor(size*.6),end);
        const b=Math.max(win.lastIndexOf('\n\n'),win.lastIndexOf('. '),win.lastIndexOf('? '),win.lastIndexOf('! '));
        if(b>-1)end=start+Math.floor(size*.6)+b+1}
      out.push({page:p.page,text:text.slice(start,end).trim()});
      if(end>=text.length)break;
      start=Math.max(end-overlap,start+1);
      const sp=text.indexOf(' ',start);if(sp>-1&&sp-start<30)start=sp+1;
    }
  }
  return out.filter(c=>c.text.length>20);
}
