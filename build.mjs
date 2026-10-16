import fs from 'node:fs/promises';
const release=JSON.parse(await fs.readFile('release.json','utf8'));
await fs.mkdir('dist',{recursive:true});
await fs.writeFile('dist/proof.json',JSON.stringify(release,null,2));
await fs.writeFile('dist/index.html','<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Isolated native Git proof</title><h1>Isolated native Git proof</h1><p>Synthetic content only. No blog source, drafts, or images.</p><p>'+release.marker+'</p></html>');
console.log('Built synthetic release '+release.version+' '+release.marker);
