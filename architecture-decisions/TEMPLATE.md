---
status: proposed
date: YYYY-MM-DD
# Add when applicable:
# supersedes: ADR-NNNN
# superseded-by: ADR-NNNN
---

# <short title naming the decision, not "ADR NNNN: ...">

## Context and Problem Statement

<Two to three sentences. What is the issue, what forces are in play, what scope of the system does this touch. Link to SPEC sections or relevant code paths. Make the scope explicit by naming the affected components or files.>

## Decision Drivers

- <Driver 1: a quality attribute, constraint, or non-functional requirement that the chosen option must satisfy.>
- <Driver 2.>

## Considered Options

- **Option A**: <one-line description.>
- **Option B**: <one-line description.>
- **Option C**: <one-line description.>

## Decision Outcome

Chose **Option X** because <one-paragraph justification grounded in the drivers above. Name the specific driver that knocked out each rejected option.>.

### Consequences

- Good, because <positive consequence: improvement of one or more desired qualities.>
- Bad, because <negative consequence: a quality you accepted compromising.>
- Neutral, because <consequence that is neither, but is worth recording.>

### Confirmation

<How will we know the decision is being followed? A test, a code review checkpoint, a fitness function, a metric, a lint rule. Skip if not applicable, but most decisions worth recording also have an observable signal of compliance.>

## Pros and Cons of the Options

### Option A

- Good, because <argument.>
- Neutral, because <argument.>
- Bad, because <argument.>

### Option B

- Good, because <argument.>
- Bad, because <argument.>

## Links

- SPEC §NN
- ADR-NNNN <related decision>
- <external doc URL, with date if applicable>
