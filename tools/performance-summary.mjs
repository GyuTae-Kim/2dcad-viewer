import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const results = {};
const median = values => [...values].sort((a,b) => a-b)[1];
for (const variant of ['baseline', 'candidate']) {
  const files = readdirSync(dir).filter(file => new RegExp(`^${variant}-\\d+\\.report\\.json$`).test(file));
  const runs = files.map(file => JSON.parse(readFileSync(join(dir,file),'utf8')));
  if(runs.length !== 3 || runs.some(run => run.runtimeError)) throw new Error('Three complete reports required');
  const rows = runs.map(({categories:c,audits:a}) => ({performance:c.performance.score*100,accessibility:c.accessibility.score*100,seo:c.seo.score*100,fcp:a['first-contentful-paint'].numericValue,lcp:a['largest-contentful-paint'].numericValue,tbt:a['total-blocking-time'].numericValue,cls:a['cumulative-layout-shift'].numericValue,jsBytes:a['network-requests'].details.items.filter(r=>r.resourceType==='Script').reduce((n,r)=>n+r.transferSize,0)}));
  results[variant] = {runs:rows,median:Object.fromEntries(Object.keys(rows[0]).map(k=>[k,median(rows.map(r=>r[k]))]))};
}
writeFileSync(join(dir,'comparison.json'),JSON.stringify(results,null,2)+'\n');
console.log('Mobile lab medians: three cold loads per build on the same runner, both gzip. These are not production PageSpeed scores.\n');
console.log('|Build|Performance|Accessibility|SEO|FCP ms|LCP ms|TBT ms|CLS|JS KiB|\n|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for(const [name,{median:r}] of Object.entries(results)) console.log(`|${name}|${r.performance}|${r.accessibility}|${r.seo}|${Math.round(r.fcp)}|${Math.round(r.lcp)}|${Math.round(r.tbt)}|${r.cls.toFixed(3)}|${(r.jsBytes/1024).toFixed(1)}|`);
