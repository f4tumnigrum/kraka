import * as v from "valibot";
export const GitObjectIdSchema = v.pipe(
  v.string(),
  v.regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  v.brand("GitObjectId"),
);
export type GitObjectId = v.InferOutput<typeof GitObjectIdSchema>;
export const WorkspaceRelativePathSchema = v.pipe(
  v.string(),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Git pathnames cannot contain NUL.
  v.regex(/^(?![A-Za-z]:)(?![/\\])(?![\s\S]*(?:^|[/\\])\.\.(?:[/\\]|$))[^\x00]+$/),
);
