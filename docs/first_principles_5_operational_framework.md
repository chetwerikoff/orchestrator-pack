# First Principles Framework — 5 режимов для регулярной инженерной работы

## Назначение

Это короткая рабочая версия фреймворка для регулярного применения в AI-orchestrator, снижении стоимости разработки и контроле качества.

Использовать часто, когда нужно быстро принять инженерное решение без запуска полного дорогого анализа на 10 режимов.

Главная цель:

> Снижать стоимость разработки без критической потери качества за счёт правильного распределения задач между скриптами, локальными моделями, дешёвыми облачными моделями и дорогими reasoning-моделями.

---

# Когда использовать

Использовать для:

- постановки задач для агента;
- выбора исполнителя: local / cheap cloud / expensive model;
- анализа дорогих прогонов;
- проверки, почему loop работает медленно или дорого;
- добавления новых функций в orchestrator;
- подготовки task.md;
- ревью workflow;
- принятия решений среднего уровня.

Не использовать для:

- совсем мелких правок;
- очевидных багфиксов;
- задач, где уже есть точный task.md и тесты;
- простых README/docs changes.

---

# 1. Real Problem Mode — настоящая проблема

## Главный вопрос

Что мы на самом деле пытаемся улучшить?

Варианты:

- стоимость;
- скорость;
- качество;
- автономность;
- устойчивость к лимитам;
- удобство контроля;
- масштабирование очереди задач;
- снижение ручного участия;
- уменьшение контекста;
- надёжность ревью.

## Мини-чеклист

- Как сейчас сформулирована задача?
- Это настоящая проблема или симптом?
- Что будет считаться успехом?
- Если решить только текущую формулировку, станет ли лучше?
- Как сформулировать задачу точнее?

## Выход

```text
Real problem:
Success criteria:
Not the goal:
```

## Пример

Плохая формулировка:

> Сделать Qwen заменой Claude.

Лучшая формулировка:

> Перенести 50–80% рутинных implementation tasks на локальную/дешёвую модель, сохранив качество через тесты, ревью и escalation rules.

---

# 2. Assumption Destruction Mode — разрушение предположений

## Главный вопрос

Какие правила мы приняли как факт, хотя это может быть просто привычка?

## Мини-чеклист

- Какие предположения есть в задаче?
- Какие из них являются hard constraints?
- Какие являются convention / habit / копированием чужого workflow?
- Что станет возможным, если их убрать?
- Какие предположения особенно увеличивают стоимость?

## Типовые предположения

- Самая сильная модель должна писать код.
- Агенту нужен весь проект в контексте.
- Ревью должен делать тот же агент.
- Если модель дешевле, качество обязательно хуже.
- Локальная модель должна заменить облачную полностью.
- Каждый loop должен включать дорогую модель.
- Больше агентов = лучше.

## Выход

```text
Assumption:
Reality check:
Hard constraint or convention:
Action:
```

---

# 3. Cost Breakdown Mode — где сгорает стоимость

## Главный вопрос

Что реально создаёт стоимость в этой задаче?

## Компоненты стоимости

- input tokens;
- cached input tokens;
- output tokens;
- reasoning/hidden compute;
- количество итераций;
- повторное чтение контекста;
- длинные ответы;
- неясный task.md;
- плохие acceptance criteria;
- отсутствие тестов;
- широкий scope;
- исправление ошибок после слабого агента;
- ручное время пользователя;
- ожидание локальной модели.

## Мини-чеклист

- Что можно сделать скриптом без LLM?
- Что может сделать локальная модель?
- Что может сделать дешёвая облачная модель?
- Где реально нужна дорогая модель?
- Какие токены можно не отправлять?
- Какие итерации можно предотвратить?
- Какой maximum iteration limit?
- Когда эскалировать?

## Выход

```text
Main cost drivers:
Can be handled by scripts:
Can be handled by local model:
Requires expensive model:
Cost reduction actions:
```

---

# 4. Clean Sheet Design Mode — как бы построили с нуля

## Главный вопрос

Если бы мы строили этот процесс сегодня с нуля, без legacy и привычек, как бы он выглядел?

## Мини-чеклист

- Какая core function?
- Какие шаги нужны обязательно?
- Какие шаги лишние?
- Где должен быть task classifier?
- Где должны быть tests?
- Где должен быть cheap reviewer?
- Где нужна дорогая модель?
- Где должны быть escalation rules?
- Как должен выглядеть минимальный pipeline?

## Базовый clean-sheet pipeline

```text
User ASK
  ↓
Task classifier
  ↓
Task.md with files/scope/acceptance criteria
  ↓
Cheapest sufficient executor
  ↓
Tests and deterministic checks
  ↓
Reviewer if needed
  ↓
Escalation only by rules
  ↓
Token/cost/quality report
```

## Выход

```text
Core function:
Clean-sheet pipeline:
What to remove from current process:
What to add:
Upgrade path:
```

---

# 5. 5 Whys Debug Mode — корневая причина

## Главный вопрос

Почему проблема повторяется?

Использовать после:

- зависания агента;
- дорогого прогона;
- провала тестов;
- плохого diff;
- лишних изменений;
- неверного понимания задачи;
- бесконечных итераций;
- падения качества после перехода на дешёвую модель.

## Мини-чеклист

```text
Problem:
Why #1:
Why #2:
Why #3:
Why #4:
Why #5:
Root cause:
Corrective action:
Prevention:
```

## Пример

Problem:

> Агент сделал лишние изменения в файлах, которые не должен был трогать.

Why #1:

> В task.md не были явно указаны forbidden files.

Why #2:

> Task generator не требует секцию do_not_touch.

Why #3:

> Нет preflight validation task.md.

Why #4:

> Orchestrator запускает задачу без проверки полноты.

Why #5:

> Task schema не является обязательной.

Root cause:

> Нет обязательной схемы и preflight-check для task.md.

Corrective action:

> Добавить task schema validator перед запуском loop.

---

# Быстрый алгоритм применения

Для обычного инженерного решения:

```text
1. Real Problem
2. Assumption Destruction
3. Cost Breakdown
4. Clean Sheet Design
5. Decision / Task.md
```

Для сбоя:

```text
1. Describe failure
2. 5 Whys
3. Root cause
4. Corrective task
5. Test/prevention
```

Для выбора модели:

```text
1. Real Problem
2. Cost Breakdown
3. Cheapest sufficient executor
4. Quality gate
5. Escalation rule
```

---

# Model routing policy

## По умолчанию

```text
Scripts/checks first
Local model second
Cheap cloud model third
Expensive model only on escalation or architecture
```

## Пример маршрутизации

| Тип задачи | Исполнитель | Проверка |
|---|---|---|
| Поиск по проекту | ripgrep/script | none |
| README/docs | local model | light review |
| CLI parameter | local model | tests |
| Parser bug | local or cheap cloud | tests + review |
| Architecture change | expensive architect | technical review |
| Risky git/data logic | expensive model | human/strict review |
| Token report/logging | local model + tests | cheap review |

---

# Короткий prompt для Claude/GPT

```text
Act as a Senior Software Architect using a compact First Principles framework.

Use the 5-mode operational framework:
1. Real Problem
2. Assumption Destruction
3. Cost Breakdown
4. Clean Sheet Design
5. 5 Whys only if analyzing a failure

Goal: reduce development cost without critical quality loss.

For the decision/task:
- identify the real problem;
- list key assumptions and destroy weak ones;
- break down token/cost/iteration drivers;
- propose a clean-sheet workflow;
- choose the cheapest sufficient executor;
- define quality gates;
- define escalation rules;
- avoid using expensive models by default.

Final output:
1. real problem;
2. assumptions to reject;
3. cost drivers;
4. recommended workflow;
5. model routing policy;
6. quality gates;
7. escalation rules;
8. concrete task.md / next action.
```

---

# Главное правило

Не спрашивать:

> Какая модель самая лучшая?

Спрашивать:

> Какой самый дешёвый достаточный исполнитель может сделать эту задачу с приемлемым риском, если качество контролируется тестами, ревью и escalation rules?
