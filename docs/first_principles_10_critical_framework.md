# First Principles Framework — 10 режимов для критического и дорогого анализа

## Назначение

Этот фреймворк используется не для каждой обычной задачи, а для дорогих, архитектурных, стратегических и рискованных решений.

Применять, когда нужно:

- принять важное архитектурное решение;
- снизить стоимость разработки без критической потери качества;
- выбрать между Cursor / Claude Code / OpenCode / Codex / локальными моделями;
- перепроектировать AI-orchestrator;
- понять, где реально сгорают токены и деньги;
- проверить, не копируем ли мы чужие решения вслепую;
- спроектировать систему с нуля;
- масштабировать процесс до очереди задач / нескольких агентов / overnight loops;
- разобраться с повторяющимися сбоями.

Главная идея: не спрашивать “какой инструмент лучше”, а разбирать проблему с нуля: реальная цель, допущения, ограничения, стоимость, архитектура, масштабирование и корневые причины.

---

# Как использовать

Полный стек из 10 режимов запускать только для задач уровня high-impact / high-cost / high-risk.

Для каждой секции агент должен:

1. явно ответить на вопросы;
2. отделять факты от предположений;
3. помечать неизвестные места;
4. не предлагать реализацию до завершения анализа;
5. в конце сформулировать решение, риски и next actions.

---

# 1. The Real Problem — что мы реально решаем

## Цель

Проверить, не решаем ли мы симптом, чужую формулировку или прокси-задачу вместо настоящей цели.

## Вопросы

- Как пользователь сейчас формулирует проблему?
- Кто и почему задал именно такую формулировку?
- Что пользователь на самом деле хочет получить на глубинном уровне?
- Если идеально решить текущую формулировку, будет ли пользователь доволен?
- Какие есть 3 альтернативные формулировки проблемы?
- Какая формулировка является настоящей?

## Выход

- Current Problem Definition
- Underlying Goal
- Problem Inheritance Check
- Alternative Framings
- Real Problem Statement

## Применение к AI-orchestrator

Не “как использовать Qwen дешевле”, а:

> Как построить процесс разработки, где дешёвые/локальные модели делают массовую работу, а дорогие модели подключаются только там, где реально нужна архитектура, reasoning или критическое ревью.

---

# 2. Assumption Destruction — разрушение предположений

## Цель

Найти правила, которые все считают обязательными, хотя это может быть просто привычка или копирование чужого workflow.

## Вопросы

- Какие предположения мы приняли как факт?
- Какие из них являются жёсткими ограничениями?
- Какие являются соглашениями, привычками или legacy?
- Откуда взялось каждое предположение?
- При каких условиях оно было разумным раньше?
- Эти условия всё ещё актуальны?
- Что станет возможным, если это предположение убрать?

## Примеры предположений для разработки

- Код должен писать самый сильный агент.
- Агенту нужно дать весь проект в контекст.
- Ревью должен делать тот же агент.
- Локальная модель должна полностью заменить Claude/Cursor.
- Если модель дешевле, качество обязательно сильно хуже.
- Чтобы ускориться, нужно просто больше агентов.
- Дорогая модель должна участвовать в каждой итерации.

## Выход

- All Assumptions
- Physics vs Convention
- Origin of Each Convention
- Obsolete Assumptions
- Opportunities If Ignored

---

# 3. Physics Test — что реально возможно

## Цель

Отделить невозможное от сложного, дорогого, медленного или непривычного.

## Вопросы

- Какие ограничения действительно физические / технически жёсткие?
- Что ограничено текущим железом?
- Что ограничено текущим софтом?
- Что возможно, но слишком дорого или медленно?
- Что возможно, но “так обычно не делают”?
- Какой путь был бы выбран, если уважать только реальные ограничения?

## Применение к локальному inference

Проверять:

- VRAM;
- RAM;
- bandwidth;
- скорость генерации;
- размер контекста;
- SSD/KV-cache;
- quantization;
- возможность держать 2 модели параллельно;
- стоимость ожидания человека.

## Выход

- Physics Constraints
- Engineering Constraints
- Economic Constraints
- Convention Constraints
- Physics-First Path

---

# 4. Constraint Removal — что если ограничение убрать

## Цель

Понять, какие ограничения настоящие, а какие самопринятые.

## Вопросы

- Какие ограничения мы считаем важными?
- Что бы мы сделали, если бы каждого ограничения не существовало?
- Это hard constraint или soft constraint?
- Можно ли его обойти процессом, архитектурой, кэшированием, тестами, очередью задач или другим исполнителем?
- Какие ограничения существуют только потому, что мы приняли текущий workflow как данность?

## Пример

Ограничение:

> Claude/Cursor лимитирован и дорогой.

Проверка:

- Это реальное ограничение? Да.
- Значит ли это, что процесс должен остановиться? Нет.
- Можно ли использовать Claude только как архитектора/валидатора? Да.
- Можно ли рутину перенести на локальную/дешёвую модель? Да.

## Выход

- All Perceived Constraints
- Hypothetical Removal
- Hard vs Soft Classification
- Self-Imposed Limits
- Unconstrained Path

---

# 5. Analogical vs First Principles — копируем или думаем с нуля

## Цель

Проверить, не переносим ли мы чужое решение в свой контекст без проверки.

## Вопросы

- Чей workflow мы копируем?
- Почему он кажется правильным?
- Совпадает ли их контекст с нашим?
- Какие ограничения были у них?
- Какие ограничения у нас другие?
- Если бы Cursor / Claude Code / OpenCode не существовали, что бы мы построили сами?

## Примеры копирования

- “Сделаем как Claude Code.”
- “Нужен session dashboard как у Anthropic.”
- “Все задачи должен вести один агент.”
- “Нужен tmux-like подход.”
- “Нужно держать весь репозиторий в контексте.”

## Выход

- Where We Think by Analogy
- Whose Solution We Copy
- Context Mismatch
- Fundamental Problem
- Rebuilt Solution from Scratch

---

# 6. Clean Sheet Design — построить с нуля

## Цель

Спроектировать идеальную систему без legacy, привычек и текущих костылей.

## Вопросы

- Какова core function системы в одном предложении?
- Что бы мы построили сегодня с текущими технологиями?
- Какие роли были бы у агентов?
- Какие задачи вообще не должны идти в LLM?
- Где нужны тесты/скрипты вместо reasoning?
- Где нужна дорогая модель?
- Чем clean-sheet система отличается от текущей?
- Как перейти от текущего состояния к clean-sheet без переписывания всего сразу?

## Clean-sheet пример для AI-orchestrator

```text
User ASK
  ↓
Task classifier
  ↓
Architect only for complex/risky tasks
  ↓
Local/cheap coder for implementation
  ↓
Tests and deterministic checks
  ↓
Cheap technical review
  ↓
Expensive review only on escalation
  ↓
Token/cost/quality report
```

## Выход

- Core Function
- Clean Sheet Design
- Differences from Current System
- Why Differences Matter
- Upgrade Path

---

# 7. Raw Materials Breakdown — где реально сгорает стоимость

## Цель

Разложить стоимость разработки на фундаментальные компоненты и найти attack points.

## Компоненты стоимости AI-разработки

- input tokens;
- cached input tokens;
- output tokens;
- hidden reasoning / compute;
- количество итераций;
- повторное чтение одного и того же контекста;
- плохой task.md;
- широкий scope;
- отсутствие тестов;
- отсутствие stopping rules;
- ручной мониторинг;
- время ожидания локальной модели;
- rollback/fix после слабого агента;
- ошибки из-за неполного контекста.

## Вопросы

- Что именно создаёт стоимость?
- Где самый большой множитель?
- Что можно заменить скриптом?
- Что можно заменить локальной моделью?
- Что требует дорогой модели?
- Какие итерации можно предотвратить лучшим task.md?
- Какие проверки можно сделать детерминированными?

## Выход

- Cost Components
- Real Cost Drivers
- Waste Sources
- Attack Points
- Expected Savings

---

# 8. 10x Thought Experiment — что если нужно в 10 раз больше

## Цель

Понять, где текущий подход сломается при масштабировании.

## Вопросы

- Что такое 10x в этой системе?
- 10x задач?
- 10x дешевле?
- 10x быстрее?
- 10x меньше ручного контроля?
- Где текущий workflow сломается?
- Какой главный bottleneck?
- Какой принципиально другой подход нужен?
- Какие выводы полезны уже на текущем масштабе?

## Пример

Если нужно запускать не 1 задачу, а 50 задач в очереди:

- нельзя каждую задачу отдавать дорогой модели;
- нужен task classifier;
- нужны model policies;
- нужны лимиты итераций;
- нужны отчёты;
- нужны escalation rules;
- нужен журнал токенов;
- нужны строгие quality gates.

## Выход

- Current Approach
- 10x Version
- Where Current Approach Breaks
- Scaling Constraint
- 10x Approach
- Insights for Current Scale

---

# 9. Outsider Perspective — взгляд умного новичка

## Цель

Вернуть beginner’s mind и найти вопросы, которые эксперт уже не задаёт.

## Вопросы

- Какие знания мы считаем очевидными?
- Какие правила новичок бы поставил под сомнение?
- Какие “глупые” вопросы могут быть на самом деле важными?
- Что бы попробовал человек без опыта Cursor/Claude Code/OpenCode?
- Какие наивные решения мы отвергаем автоматически?
- Какие из них могут сработать лучше текущего подхода?

## Примеры outsider-вопросов

- Почему вообще LLM должна читать весь проект?
- Почему код пишет модель, а не генерируется из более строгих спецификаций?
- Почему ревью делает LLM, а не набор проверок + маленький валидатор?
- Почему задача не классифицируется до запуска?
- Почему стоимость не является first-class metric?

## Выход

- Insider Knowledge
- Insider Assumptions
- Beginner Questions
- Naive Solutions
- Valuable Naive Approaches

---

# 10. 5 Whys — корневая причина

## Цель

Использовать после сбоя: зависание агента, плохой diff, лишние изменения, дорогой прогон, провал тестов.

## Вопросы

- Что именно произошло?
- Почему это произошло? #1
- Почему возникла эта причина? #2
- Почему возникла следующая причина? #3
- Почему система позволила этому случиться? #4
- Какой root cause? #5
- Если исправить root cause, проблема перестанет повторяться?

## Пример

Проблема:

> Агент потратил много токенов и не решил задачу.

5 Whys:

1. Почему? Получил слишком широкий контекст.
2. Почему? В task.md не были ограничены файлы.
3. Почему? У orchestrator нет обязательного `files_to_read` / `files_to_modify`.
4. Почему? Task generator не валидирует полноту task.md.
5. Почему? Нет preflight-check перед запуском loop.

Root cause:

> Нет preflight validation задачи перед запуском агента.

Action:

> Добавить task preflight validator.

## Выход

- Problem
- Why #1
- Why #2
- Why #3
- Why #4
- Why #5
- Root Cause
- Corrective Action

---

# Финальное решение после полного анализа

После прохождения 10 режимов агент должен выдать:

```text
1. Real problem
2. Key assumptions destroyed
3. Real hard constraints
4. Soft/self-imposed constraints
5. Cost drivers
6. Clean-sheet architecture
7. 10x scalability risks
8. Root causes of current problems
9. Recommended decision
10. Risks and tradeoffs
11. Implementation plan
12. What NOT to do
```

---

# Когда использовать этот полный фреймворк

Использовать для:

- крупных архитектурных решений;
- дорогих изменений;
- выбора модели/инструмента;
- redesign orchestrator;
- стратегии снижения стоимости;
- масштабирования agent pipeline;
- повторяющихся failures;
- решений, которые потом сложно откатить.

Не использовать для:

- мелких CLI-параметров;
- README;
- простого логирования;
- простых багфиксов;
- генерации обычных тестов;
- задач, которые можно проверить deterministic checks.

---

# Короткий prompt для Claude/GPT

```text
Act as a Senior Software Architect and First Principles Analyst.

Use the full 10-mode First Principles Framework because this is a high-impact / high-cost / high-risk decision.

Analyze the problem through these modes:
1. The Real Problem
2. Assumption Destruction
3. Physics Test
4. Constraint Removal
5. Analogical vs First Principles
6. Clean Sheet Design
7. Raw Materials / Cost Breakdown
8. 10x Thought Experiment
9. Outsider Perspective
10. 5 Whys

For each mode:
- separate facts from assumptions;
- identify hard constraints vs conventions;
- call out unknowns;
- avoid premature implementation;
- focus on cost reduction without critical quality loss.

Final output:
1. real problem;
2. destroyed assumptions;
3. true constraints;
4. cost drivers;
5. clean-sheet solution;
6. 10x scaling implications;
7. root causes;
8. recommended decision;
9. risks/minuses;
10. implementation plan;
11. what NOT to do.
```
