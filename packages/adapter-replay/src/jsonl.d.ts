/** Import with Bun's text attribute to preserve line boundaries and native frame bytes. */
declare module "*.jsonl" {
  const text: string;
  export default text;
}
