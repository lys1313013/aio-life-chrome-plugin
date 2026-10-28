/* Browser shim only loaded by tests/harness.js; never referenced by extension manifest. */
const fixtureKind = new URL(location.href).searchParams.get('fixture') || 'purchase';
let taken = false;
window.chrome = {
  runtime: {sendMessage: async message => {
    if (message.type === 'CAPTURE_TAKE') {
      if (taken) return {success: false, error: '采集内容已读取，请重新采集'};
      taken = true;
      const seed = await fetch(`/__capture/seed?kind=${fixtureKind}`).then(r => r.json());
      return {success: true, data: seed.state};
    }
    return (await fetch('/__capture/message', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(message)})).json();
  }},
  permissions: {request: async () => false, contains: async () => false}
};
