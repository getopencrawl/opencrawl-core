/** Portable product boundary. Runtimes authenticate; core enforces resource access.
 * This greeting has no resources. See ARCHITECTURE.md before adding operations.
 */
export function hello() {
  return { message: 'hello world' };
}
