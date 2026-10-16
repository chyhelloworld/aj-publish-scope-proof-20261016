import { getStore } from '@edgeone/pages-blob';
import { createAuthorHandler } from '../../author-core.js';

let store;
export default function onRequest(context){
  return createAuthorHandler({
    getStore:()=>store??=(getStore({name:'author-probe-v1',consistency:'strong'})),
    env:{...process.env,...context.env},
  })(context.request);
}
