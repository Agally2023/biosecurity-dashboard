// Caches the app shell so the app opens fast and even offline. Data requests (Supabase) are never cached.
const V='bio-v10',SHELL=['./','index.html','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/apple-touch-icon.png','assets/vf-logo.png','assets/vf-logo-white.png','assets/vf-cover.jpg','assets/vf-fish.jpg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin)return;           // Supabase etc. go straight to the network
  const page=r.mode==='navigate'||/\/(index\.html)?$/.test(u.pathname)||/sw\.js$/.test(u.pathname);
  if(page){ // newest version first (waits at most 3 seconds), saved copy if offline or slow
    e.respondWith(caches.open(V).then(c=>new Promise(res=>{let done=false;const old=()=>c.match(r).then(m=>m||c.match('index.html')),to=setTimeout(()=>old().then(m=>{if(m&&!done){done=true;res(m)}}),3000);
      fetch(r,{cache:'no-cache'}).then(n=>{clearTimeout(to);if(n.ok)c.put(r,n.clone());if(!done){done=true;res(n)}}).catch(()=>{clearTimeout(to);if(!done){done=true;old().then(res)}})})));return}
  e.respondWith(caches.open(V).then(c=>c.match(r).then(m=>{const net=fetch(r).then(res=>{if(res.ok)c.put(r,res.clone());return res}).catch(()=>m);return m||net})))});
