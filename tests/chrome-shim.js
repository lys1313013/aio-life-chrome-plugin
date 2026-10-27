/* Browser shim only loaded by tests/harness.js; never referenced by extension manifest. */
const fixtureKind = new URL(location.href).searchParams.get('fixture') || 'purchase';
const seedPromise = fetch(`/__capture/seed?kind=${fixtureKind}`).then(r=>r.json()).then(seed=>{
  const key=`capture:${seed.id}`;
  if (!localStorage.getItem(key) || JSON.parse(localStorage.getItem(key)).kind !== fixtureKind) localStorage.setItem(key,JSON.stringify(seed.state));
  return seed;
});
window.chrome = {
  runtime: {sendMessage: async message => (await fetch('/__capture/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)})).json()},
  storage: {local: {
    get: async key => { await seedPromise; return {[key]:JSON.parse(localStorage.getItem(key)||'null')}; },
    set: async values => { for(const [key,value] of Object.entries(values)) localStorage.setItem(key,JSON.stringify(value)); },
    remove: async key => localStorage.removeItem(key)
  }},
  permissions:{request:async()=>false,contains:async()=>false}
};
