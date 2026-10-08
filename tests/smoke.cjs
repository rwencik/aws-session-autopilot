'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..');
function mock(initial = {}) {
  const listeners = {}, store = { local: initial.local || {}, session: initial.session || {} };
  const portals = {10: 'https://d-test.awsapps.com/start/'};
  const limit = 'https://eu-west-1.signin.aws.amazon.com/sessions/limit';
  const logout = 'https://eu-west-1.signin.aws.amazon.com/sessions/339712800131-session/v1/logout';
  for (const id of [20, 21, 22]) portals[id] = limit;
  const close = [], sent = [];
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    storage: {
      local: {
        get: async key => ({ [key]: store.local[key] }),
        set: async values => Object.assign(store.local, values),
        remove: async key => { delete store.local[key]; }
      },
      session: {
        get: async key => ({ [key]: store.session[key] }),
        set: async values => Object.assign(store.session, values)
      }
    },
    tabs: {
      onCreated: event('created'), onUpdated: event('updated'), onRemoved: event('removed'),
      get: async id => ({ id, url: portals[id] }),
      sendMessage: async (id, payload) => { sent.push([id, payload]); return {ok:true}; },
      remove: async id => { close.push(id); },
      update: async (id, options) => { portals[id] = options.url; return {id,url:options.url}; },
      query: async () => Object.entries(portals).map(([id,url]) => ({id:+id,url}))
    },
    runtime: {onMessage: event('message'), onInstalled: event('installed')}
  };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'background.js'),'utf8'), {
    chrome, URL, Date, console, setTimeout
  }, {filename:'background.js'});
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = (type,id=10) => new Promise((resolve,reject) => {
    const to = setTimeout(() => reject(new Error(`Timed out: ${type}`)),1000);
    listeners.message({type}, {tab: {id,url:portals[id],openerTabId:id===10?undefined:10}}, result => {
      clearTimeout(to); resolve(result);
    });
  });
  const arm = async id => {
    listeners.created({id,openerTabId:10}); await wait(15);
    return send('ARM_CLOSE_ON_LOGOUT',id);
  };
  const confirm = async id => {
    portals[id] = logout;
    return send('LOGOUT_CONFIRMED',id);
  };
  return {listeners,store,portals,close,sent,wait,send,arm,confirm};
}
(async()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
  assert.equal(manifest.version,'0.8.0');
  assert.equal(manifest.action.default_popup,'popup.html');
  for(const size of [16,32,48,128]) assert(fs.existsSync(path.join(base,manifest.icons[size])));
  const popup=fs.readFileSync(path.join(base,'popup.html'),'utf8');
  assert(!/<button\b|<input\b|observed|Reset observations|Reset safety stop/i.test(popup));
  assert.match(popup,/Always on/);
  assert(!fs.existsSync(path.join(base,'popup.js')));
  const content=fs.readFileSync(path.join(base,'content.js'),'utf8');
  assert(!/GET_STATE|Automation disabled/.test(content));
  assert.match(content,/sessions-limit-signout-and-continue/);
  console.log('PASS: zero-configuration manifest, icon sizes, passive popup, always-on content script');

  const a=mock({local:{aws_fifo_state:{enabled:false,retryEnabled:false,sessions:[{id:'old'}]}}});
  await a.listeners.installed({reason:'update'});
  assert(!Object.hasOwn(a.store.local,'aws_fifo_state'));
  await a.send('PORTAL_LAUNCH');
  assert.equal((await a.arm(20)).ok,true);
  assert.equal((await a.confirm(20)).retried,true);
  const account = 'https://123456789012-newabc.eu-west-1.console.aws.amazon.com/console/home';
  a.portals[30]=account;
  a.listeners.updated(30,{url:account},{id:30,url:account});
  await a.wait(40);
  assert.equal(a.store.session.aws_fifo_temporary.retryGuard,null);
  // Second sign-in, without touching extension popup at any point.
  assert.equal((await a.arm(21)).ok,true);
  assert.equal((await a.confirm(21)).retried,true);
  assert.deepEqual(a.close,[20,21]);
  assert.deepEqual(a.sent.map(([id,m])=>[id,m.type]),[[10,'RETRY_PORTAL_LAUNCH'],[10,'RETRY_PORTAL_LAUNCH']]);
  console.log('PASS: migration clears old disabled preferences; two consecutive automatic logouts/retries');

  const b=mock();
  await b.send('PORTAL_LAUNCH');
  assert.equal((await b.arm(20)).ok,true);
  assert.equal((await b.confirm(20)).retried,true);
  const refused=await b.arm(21);
  assert.equal(refused.ok,false);
  assert.match(refused.reason,/Safety stop/);
  console.log('PASS: retry loop cannot silently log out a second session');
  // A fresh click on access portal is enough to unlock a NEW attempt.
  await b.send('PORTAL_LAUNCH');
  assert.equal((await b.arm(22)).ok,true);
  console.log('PASS: new real access-portal click unlocks a separate sign-in without any popup controls');
})().catch(e=>{console.error(e);process.exitCode=1});
