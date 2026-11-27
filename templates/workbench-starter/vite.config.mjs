// Relative base: the built dist/ works from any subpath, such as /starter/ or /my-team/gate/.
export default {
  base: './',
  esbuild: { jsx: 'automatic' },
  worker: { format: 'es' },
};
