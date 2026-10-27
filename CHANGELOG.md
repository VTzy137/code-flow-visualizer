# Changelog

## 0.2.0

- **Class flow view**: inheritance, implemented interfaces, constructor injection, DI registrations
  (`AddSingleton` / `AddScoped` / `AddTransient` / `AddHostedService` / `AddDbContext` / `AddHttpClient`,
  generic, `typeof` and factory forms), interface → implementation bindings, and where objects are created with `new`.
- Type roles highlighted: controller, background service, db context, SignalR hub, Razor page, WinForms form, …
- **DI · Program.cs** entry for files that register services.
- Sidebar split into **Functions** and **Classes** folders.
- New editor command: **Show Class Flow for Type at Cursor**.
- New setting `codeFlow.classInitialDepth`.

## 0.1.0

- Conditional call graph for C#: branch conditions on arrows (if/else, guard clauses, switch, ternary, `&&`/`||`, `?.`, `??`),
  interface and virtual dispatch resolved to implementations.
- Condition labels drawn as boxes on the edge so they never overlap nodes; readable minimum zoom on fit.
