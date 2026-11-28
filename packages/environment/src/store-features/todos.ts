import { markStartupDetail } from "../capture-timing";
import { TodoLedger, todoTables } from "../todo-ledger";
import type { WithServices } from "./types";
type Services = { todos: TodoLedger };
export const todos: WithServices<Services> = {
  schema: {
    order: 50,
    afterJournal: true,
    run(db) {
      db.exec(todoTables);
    },
  },
  services: {
    order: 20,
    create(store) {
      return { todos: new TodoLedger(store) };
    },
  },
  initialize: {
    order: 10,
    run(store) {
      store.todos.recover();
      markStartupDetail("db.todos");
    },
  },
};
