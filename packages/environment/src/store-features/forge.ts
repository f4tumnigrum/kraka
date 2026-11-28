import { readProject } from "../first-send-store";
import { GitHubAccounts, readGitHubConfig } from "../forge-account";
import type { WithServices } from "./types";

export const forge: WithServices<{ forge: GitHubAccounts }> = {
  services: {
    order: 35,
    create(store) {
      return {
        forge: new GitHubAccounts({
          config: () => readGitHubConfig(store.writer.stateDirectory),
          project(id) {
            const project = readProject(store.db, id);
            return project?.environmentId === store.writer.environmentId
              ? { project, directory: store.projectDirectory(id) }
              : null;
          },
        }),
      };
    },
  },
};
