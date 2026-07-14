/**
 * Test-only surface: lets other packages' tests mock HTTP without importing
 * undici directly (the "network clients only inside ../net" rule applies to
 * tests too). Import from '../net/testing'.
 */
export { MockAgent } from 'undici';
