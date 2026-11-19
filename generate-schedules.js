
import { topUpAllSeries } from './src/lib/series.js';

try {
  const created = await topUpAllSeries();

  console.log('Schedule generation completed.');
  console.log('New sessions created:', created);

  process.exitCode = 0;
} catch (error) {
  console.error('Schedule generation failed:', error);
  process.exitCode = 1;
}
