// TF-IDF keyword index and hybrid ranking (spec 5.5, 5.6). Shared by the page and the tests.
export const STOP=new Set('a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those i you he she we they them our your their my me do does did not no so than then there here what which who whom when where why how can could should would will shall may might must have has had into about over under up down out also just only very more most such each any all some'.split(' '));
export const stem=w=>w.length>4?w.replace(/(ies)$/,'y').replace(/(ing|edly|ed|es|s)$/,''):w;
export const tokens=s=>(s.toLowerCase().match(/[a-z0-9À-￿]+/g)||[]).filter(w=>!STOP.has(w)&&w.length>1).map(stem);
export function tf(toks){const m=new Map();for(const t of toks)m.set(t,(m.get(t)||0)+1);return m}
export function vec(tfm,idf){const v=new Map();let n=0;for(const[t,c]of tfm){const w=(1+Math.log(c))*(idf.get(t)||0);if(w){v.set(t,w);n+=w*w}}return{v,n:Math.sqrt(n)||1}}

/** Builds idf over the chunks (each needs .tf), sets chunk.vec, and returns the idf map. */
export function buildIndex(chunks){
  const df=new Map();for(const c of chunks)for(const t of c.tf.keys())df.set(t,(df.get(t)||0)+1);
  const N=chunks.length;const idf=new Map([...df].map(([t,d])=>[t,Math.log((N+1)/(d+.5))]));
  for(const c of chunks)c.vec=vec(c.tf,idf);
  return idf;
}
export const dot=(a,b)=>{let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s};
export function keywordScore(qv,c){let s=0;for(const[t,w]of qv.v){const x=c.vec.v.get(t);if(x)s+=w*x}return s/(qv.n*c.vec.n)}

/**
 * Hybrid score: 80% Gemini semantic similarity + 20% keyword match
 * (keyword-only when the query or the chunk has no embedding). Returns top-k with score > 0.
 */
export function rank(chunks,q,idf,qe,k){
  const qv=vec(tf(tokens(q)),idf);
  return chunks.map(c=>{const k1=keywordScore(qv,c);const sem=qe&&c.emb?dot(qe,c.emb):null;return{c,score:sem==null?k1:.8*sem+.2*k1,sem}})
    .filter(r=>r.score>0).sort((a,b)=>b.score-a.score).slice(0,k);
}
