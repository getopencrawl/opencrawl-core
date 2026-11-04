/** Portable product boundary. Identity and access policy belong to the caller. */
export function hello() {
  return { message: 'hello world' };
}

export function renderHello() {
  return '<main><h1>hello world</h1></main>';
}
