export const REFERENCE_LIMITS = Object.freeze({ reads:32, textChars:64000, imageBytes:4*1024*1024, repeats:3 });
export function referenceRequest(args) {
  let path=typeof args.path==='string'?args.path.trim():'';
  while(path.startsWith('./'))path=path.slice(2);
  if(args.directory===true)path=path.replace(/\/+$/,'');
  return {id:args.id,path,directory:args.directory===true};
}
export function referenceKey(args) { const r=referenceRequest(args);return JSON.stringify([r.id,r.path,r.directory]); }
