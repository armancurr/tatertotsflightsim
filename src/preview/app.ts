import { startApp } from '../game/app';
startApp(document.getElementById('app')!, document.getElementById('hud')!).catch((e) => console.error('startApp failed', e));
