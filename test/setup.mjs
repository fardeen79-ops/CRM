// Pins the timing rules' clock to a weekday morning (Monday 10:00 UAE) so the suite behaves the
// same whenever it runs; the timing test moves it on purpose.
import { timing } from '../src/cases.js';
timing.now = () => Date.parse('2026-10-05T06:00:00Z');
