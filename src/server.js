import { buildApp } from './app.js';
import { config } from './config.js';

buildApp().listen(config.port, () => {
  console.log(`tarunam-lite listening on http://localhost:${config.port}`);
});