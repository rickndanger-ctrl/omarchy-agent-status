import './style.css';
import { ListenHub } from './hub';
import { createListenApp } from './main';

const storage = { url: 'muse-listen.v1.hub', token: 'muse-listen.v1.token' };
const read = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const root = document.getElementById('app')!;
const setup = document.createElement('form'); setup.className = 'setup';
const addressLabel = document.createElement('label'); addressLabel.textContent = 'Private Listen hub URL (include /hud/ when used)';
const address = document.createElement('input'); address.type = 'url'; address.required = true; address.placeholder = 'https://your-hub.example/hud/'; address.value = read(storage.url); addressLabel.append(address);
const tokenLabel = document.createElement('label'); tokenLabel.textContent = 'Hub bearer token';
const token = document.createElement('input'); token.type = 'password'; token.autocomplete = 'off'; token.value = read(storage.token); tokenLabel.append(token);
const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save hub & connect display';
const notice = document.createElement('p'); notice.className = 'status'; notice.textContent = 'Saved on this phone only. Connecting never starts the microphone.';
setup.append(addressLabel, tokenLabel, save, notice);
const mount = document.createElement('section'); root.append(setup, mount);
const app = createListenApp({ hub: () => new ListenHub({ url: address.value.trim(), token: token.value.trim() }), mount,
  diag: name => console.info(name) });
setup.addEventListener('submit', async event => {
  event.preventDefault();
  if (app.view().micOn || ['starting', 'stopping'].includes(app.view().phase)) { notice.textContent = 'Stop listening before changing the hub.'; return; }
  try {
    new ListenHub({ url: address.value.trim(), token: token.value.trim() });
    localStorage.setItem(storage.url, address.value.trim()); localStorage.setItem(storage.token, token.value.trim());
    await app.connect(); notice.textContent = 'Hub saved. Select or Start when you want to listen.';
  } catch { notice.textContent = 'Could not save this hub. Check its URL and local storage.'; }
});
window.addEventListener('pagehide', () => { void app.close(); });
void app.connect();
