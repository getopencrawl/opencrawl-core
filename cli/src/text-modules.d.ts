/** Bun embeds these files as text (`with {type:'text'}`). */
declare module '*.md' {
  const text: string;
  export default text;
}
