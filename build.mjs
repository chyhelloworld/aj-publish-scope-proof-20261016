// Build only the approved public snapshot. This is not the blog source build.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchPublication, buildPublication } from './publication-build.js';
const manifestBytes=await fs.readFile('published-manifest.json');
const manifest=JSON.parse(manifestBytes);
const allowedExtensions=new Set(['.html','.xml','.png','.webp','.js','.css','.woff','.woff2']);
const source=path.resolve('site');
const output=path.resolve('dist');
const publication=await fetchPublication();
for(const file of manifest.files){
  if(file.path.startsWith('/')||file.path.includes('\\')||file.path.split('/').includes('..')||!allowedExtensions.has(path.extname(file.path)))throw new Error('Invalid public manifest path');
  const bytes=await fs.readFile(path.join(source,file.path));
  if(bytes.length!==file.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error(`Public snapshot mismatch: ${file.path}`);
}
await fs.mkdir(output,{recursive:true});
if((await fs.readdir(output)).length)throw new Error('Public build output must start empty');
for(const file of manifest.files){
  const destination=path.join(output,file.path);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.copyFile(path.join(source,file.path),destination);
}
const proof={marker:manifest.exportId,manifestSha256:crypto.createHash('sha256').update(manifestBytes).digest('hex'),fileCount:manifest.files.length,articleCount:manifest.articles.length,imageCount:manifest.images.length};
await fs.writeFile(path.join(output,'__public_export_probe.json'),JSON.stringify(proof,null,2));
await fs.mkdir(path.join(output,'author-probe'),{recursive:true});
for(const name of ['index.html','style.css','app.js','session.js','fonts.css'])await fs.copyFile(path.join('author-probe',name),path.join(output,'author-probe',name));
await fs.mkdir(path.join(output,'git-content-probe'),{recursive:true});
for(const name of ['index.html','app.js'])await fs.copyFile(path.join('git-content-probe',name),path.join(output,'git-content-probe',name));
const publicationMarker=await buildPublication(publication,output);
console.log(JSON.stringify({publicationBuilt:true,...publicationMarker}));
console.log(JSON.stringify({publicSnapshotBuilt:true,...proof}));
