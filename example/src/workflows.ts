import { Effect } from "effect";
import {
  createTodo,
  completeTodo,
  reopenTodo,
  getTodo,
  listTodos,
  deleteTodo,
  stats,
  type TodoPriority,
} from "./todos/sql.js";

/**
 * Create a todo and immediately complete it if priority is urgent.
 */
export const createAndMaybeComplete = (title: string, priority: TodoPriority) =>
  Effect.gen(function* () {
    const [todo] = yield* createTodo({
      title,
      description: "",
      priority,
      shareWith: null,
      fido: null,
    });
    yield* Effect.log(`Created: "${todo.title}" [${todo.priority}]`);

    if (priority === "urgent") {
      const [completed] = yield* completeTodo({ id: todo.id });
      yield* Effect.log(`Auto-completed urgent todo: "${completed.title}"`);
      return completed;
    }

    return todo;
  });

/**
 * Toggle a todo's done state.
 */
export const toggleTodo = (id: number) =>
  Effect.gen(function* () {
    const [todo] = yield* getTodo({ id });

    if (todo.done) {
      const [reopened] = yield* reopenTodo({ id: todo.id });
      yield* Effect.log(`Reopened: "${reopened.title}"`);
      return reopened;
    }

    const [completed] = yield* completeTodo({ id: todo.id });
    yield* Effect.log(`Completed: "${completed.title}"`);
    return completed;
  });

/**
 * Purge all completed todos.
 */
export const purgeCompleted = Effect.gen(function* () {
  const todos = yield* listTodos;
  const completed = todos.filter((t) => t.done);

  for (const todo of completed) {
    yield* deleteTodo({ id: todo.id });
    yield* Effect.log(`Deleted: "${todo.title}"`);
  }

  const [counts] = yield* stats;
  yield* Effect.log(
    `Purged ${completed.length} todos. ${counts.pending} remaining.`,
  );

  return { purged: completed.length, remaining: counts.pending };
});

/**
 * Seed the database with sample todos.
 */
export const seed = Effect.gen(function* () {
  const items: { title: string; desc: string; priority: TodoPriority }[] = [
    { title: "Buy groceries", desc: "Milk, eggs, bread", priority: "high" },
    { title: "Deploy v2", desc: "Run migrations first", priority: "urgent" },
    { title: "Read Effect docs", desc: "", priority: "low" },
    {
      title: "Fix login bug",
      desc: "Session cookie expires too early",
      priority: "high",
    },
    { title: "Update README", desc: "", priority: "medium" },
  ];

  for (const item of items) {
    yield* createTodo({
      title: item.title,
      description: item.desc,
      priority: item.priority,
      shareWith: null,
      fido: "tukac",
    });
  }

  const [counts] = yield* stats;
  yield* Effect.log(`Seeded ${counts.total} todos`);
});
