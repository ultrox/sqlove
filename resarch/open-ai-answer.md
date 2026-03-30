SQL query-level nullability inference for SELECT expressions in PostgreSQL
Findings and answer to the key question
PostgreSQL does not expose query-result (SELECT output) nullability as a first-class, query-level property via its SQL interface or wire protocol; clients receive types (and sometimes base table/column IDs), but not “this output column can/can’t be NULL”. 

That said, PostgreSQL’s own planner already performs non-trivial nullability reasoning to optimise outer joins (e.g., reducing a LEFT JOIN to an INNER JOIN when upper-level predicates force non-nullness), and this reasoning explicitly depends on both (a) boolean-logic structure (AND vs OR) and (b) strictness of functions/operators (which is derived from pg_proc.proisstrict). 

So, “pg_proc.proisstrict + WHERE-clause analysis” is enough to become consistent, but only if you adopt a conservative contract:

You can be sound (never claim NOT NULL when NULL is possible) by reusing the planner’s notion of “strictness” plus its AND/OR propagation rules. 
You cannot be complete (prove all non-null outputs) because strictness metadata only says NULL-in ⇒ NULL-out, not non-NULL-in ⇒ non-NULL-out, and SQL has many constructs where NULL-ness is data-dependent (e.g., NULLIF, aggregates, scalar subqueries, outer joins, and user-defined functions that may return NULL for non-NULL inputs). 
In practical terms: PostgreSQL gives you enough internal machinery to avoid “random heuristics” if you align your inference rules with the planner’s (strictness + boolean structure + outer-join nulling), and treat the rest as “unknown ⇒ nullable”. 

What PostgreSQL exposes and why clients can’t get query-time nullability
At the protocol level, the server’s RowDescription message lists per-field name, table OID (or 0), attribute number (or 0), type OID, type length, typmod, and format code—but no nullability flag. 

This is not just an omission in one driver: PostgreSQL core discussions around result descriptors explicitly note that RowDescription “doesn’t contain nearly enough information (no nullability)” for meta-programming/driver needs, and changing the wire protocol is treated as a major compatibility concern. 

As a consequence, a client using libpq/C cannot ask “is this projected column nullable?” in general: query result columns may be expressions unrelated to a base table column, and result-set metadata is not required to include table-definition facts. 

Even when a result column can be traced to a table column (via protocol fields or libpq helpers like PQftablecol/table OID), that only tells you provenance—not query-context nullability (e.g., the same base column becomes nullable if it is null-extended by an outer join). 

A closely related symptom is that PostgreSQL often does not maintain strong NOT NULL metadata for derived schema objects (notably views): practitioners observe that view-column nullability is mostly “informational” and often left as nullable because it is not enforced on the view itself and because deriving it is extra work that historically wasn’t prioritised. 

For contrast, some other DBMSs explicitly provide “describe the first result set” metadata that includes nullability (e.g., SQL Server’s sp_describe_first_result_set), implemented as a static analysis pass; PostgreSQL does not ship an equivalent facility. 

What the PostgreSQL planner already infers
Although PostgreSQL does not export query-level nullability, it tracks the essential ingredients internally:

Outer-join null extension is represented explicitly in the parse/planner structures. During parsing, PostgreSQL marks Var nodes as nullable if they can be nulled by outer joins (markNullableIfNeeded). 

In planner preprocessing, PostgreSQL maintains, per range-table entry, the set of outer joins that can null that relation (nullingrels[rti]). 

Planner code also has detailed machinery to ensure Var nodes carry correct “nulling bitmaps” even after join reordering, because outer join identities can commute and still require consistent null-extension semantics. 

WHERE/qualifier constraints are analysed to infer non-null requirements, with explicit AND/OR semantics. The planner computes sets like “nonnullable rels” and “nonnullable vars” from boolean clauses, carefully handling OR via intersection rules rather than naïve unioning. 

This connects directly to your stated hard case: “WHERE x IS NOT NULL makes x non-null under AND, but OR breaks the guarantee.” That is exactly how PostgreSQL treats it: AND at top level can union facts; OR requires intersection across arms because OR is only strict if all arms are strict. 

Function/operator strictness is a first-class signal and is catalog-backed. PostgreSQL defines strict functions as those that “return null whenever any argument is null” (and are not executed on null arguments). 

This property is stored in pg_proc.proisstrict. 

Internally, planner helper func_strict(funcid) is literally “return pg_proc.proisstrict”. 

The non-null inference walkers explicitly recurse through FuncExpr and OpExpr only when the underlying function/operator is strict. 

This inference is used for real transformations of join semantics. In reduce_outer_joins_pass2, PostgreSQL uses find_nonnullable_rels to turn LEFT/RIGHT/FULL joins into INNER joins when upper quals imply non-nullness on the nullable side. 

It also uses find_nonnullable_vars plus “forced-null vars” to justify additional strength reductions (including to anti-joins in some patterns), showing that “non-nullness facts” are coupled tightly to join reasoning rather than being a superficial annotation. 

Net: PostgreSQL already contains a sound core for the two missing pieces you highlighted—(1) boolean-clause narrowing and (2) strict function/operator null propagation—but it lives in server internals and is not returned as a query-result contract. 

A sound nullability inference algorithm you can copy from PostgreSQL internals
If your goal is “consistent rather than heuristic”, the most defensible approach is to implement an abstract interpretation that matches PostgreSQL’s notion of strictness and boolean propagation, and to only assert NOT NULL when you can prove it with these rules. 

A practical decomposition that aligns with what PostgreSQL already does internally looks like this:

Track two independent sources of NULL: outer-join null extension and intrinsic/expression NULL.

Outer-join null extension (“nullingrels/varnullingrels”). A base column that is NOT NULL at the table level can still become nullable when it is pulled from the nullable side of an outer join (LEFT/RIGHT/FULL), because unmatched rows are emitted with null-extended columns. PostgreSQL’s own tutorial states this explicitly for LEFT JOIN: when there is no match, “empty (null) values are substituted for the right-table columns.” 

Your existing plan-tree walk already approximates this; the key consistency improvement is ensuring it agrees with PostgreSQL’s semantic nulling model when joins are reordered (the reason nulling bitmaps exist). 

Predicate-derived non-nullness facts (“nonnullable vars”). Implement (or port) PostgreSQL’s find_nonnullable_vars logic:

At top-level AND: union non-null facts across conjuncts. 
Under OR (and under AND below top-level): intersect facts across arms, because OR/AND can yield non-NULL even if one arm sees NULL, so you can only assert what holds in all arms. 
Treat IS NOT NULL and boolean tests that reject NULL (IS TRUE, IS FALSE, IS NOT UNKNOWN) as “strict at top level” sources of non-nullness for their argument. 

This directly resolves your “AND vs OR breaks guarantee” limitation in a principled (planner-consistent) way. 
Strict function/operator propagation (“NULL-in ⇒ NULL-out”). For expression nodes:
If a function/operator is strict, the expression is nullable if any input is nullable; conversely, you can only consider it non-null if you know all inputs are non-null and you have separate knowledge the function cannot return NULL on non-NULL inputs (strictness alone is not enough to prove non-null). 
PostgreSQL’s own walkers treat FuncExpr and OpExpr as strict exactly when func_strict(...) is true, which is a direct lookup of pg_proc.proisstrict. 

This directly covers your “upper(nullable_col) should be nullable if upper is strict” and “arithmetic propagation” issues, because arithmetic operators are OpExpr nodes whose strictness is evaluated via the underlying function. 
Special forms with explicit NULL semantics (COALESCE/CASE/NULLIF). Here PostgreSQL documentation is unusually specific and can be treated as ground truth:
COALESCE returns the first non-null argument; it returns NULL only if all arguments are NULL, and it short-circuits evaluation. 

So, COALESCE only “removes NULL” when you can prove at least one argument is non-null in all rows that survive earlier predicates (or when you accept a conservative default: if all args are nullable, result is nullable). 
CASE returns NULL if no condition matches and there is no ELSE, and it does not evaluate unnecessary arms (modulo planner-time constant folding caveats). 
NULLIF returns NULL if its arguments are equal (so it can return NULL even when both inputs are non-null). 

These documented semantics give you principled handling for several of your current AST-level cases and avoid “COALESCE always removes NULL” as an inconsistent special case. 
What this buys you in user experience terms: it becomes explainable and monotone: “we only mark NOT NULL when it follows from (outer-join nulling model) ∧ (boolean-logic proof of non-null) ∧ (strictness-based propagation) ∧ (documented special forms).” PostgreSQL itself uses essentially this style of reasoning for join reductions, which is a strong argument that it is not arbitrary. 

Integrity constraints and generated columns as extra signal
Your question includes two schema-side enhancements—CHECK constraints and generated columns—that can, in principle, strengthen query-level nullability conclusions. PostgreSQL supports both, but their interaction with NULL is subtle.

CHECK constraints are NULL-tolerant unless they mention IS NOT NULL. PostgreSQL documentation states: a CHECK constraint is satisfied if the check expression evaluates to TRUE or to NULL (unknown); since most expressions become NULL if any operand is NULL, CHECK constraints “will not prevent null values” unless you explicitly test for non-nullness. 

This means “CHECK constraints that effectively prevent NULL” is a smaller set than it may appear: you mostly care about constraints that syntactically (or logically) imply col IS NOT NULL, not arbitrary predicates like col > 0 (which do not reject NULL). 

Constraint validity and transactional semantics matter for soundness. PostgreSQL allows constraints to be created as NOT VALID (so existing rows are not checked until validation), and system catalog fields like pg_constraint.convalidated are used to track validation state in practice discussions. 

If your analyser wants to be sound “at query time”, treating an unvalidated CHECK as fully enforced can be wrong for legacy data; therefore, constraint-derived non-nullness should (at minimum) be conditioned on validation state. 

Generated columns: virtual vs stored affects where inference is safest. PostgreSQL docs describe generated columns as always computed from other columns, with stored generated columns computed on write and virtual generated columns computed on read. 

PostgreSQL 18’s implementation expands virtual generated columns by rewriting query Var references to their generation expressions during planning/optimisation (via expand_virtual_generated_columns). 

From an inference perspective, this is conceptually good news: once expanded, they are “just expressions” and can be analysed with the same strictness/COALESCE/CASE rules you use elsewhere (while still respecting outer-join nulling and predicate narrowing). 

However, “generated column has a NOT NULL generation expression” is not automatically the same as “column is declared NOT NULL”: without an explicit NOT NULL constraint, outer joins and query context can still introduce NULLs at the projection level even if the expression itself tends not to. 

Net: constraints and generated-column expressions can improve precision, but only if you (1) respect SQL’s NULL-tolerant CHECK semantics, and (2) incorporate validation state and join null-extension into the reasoning. 

Related work and why full precision remains hard
Academic and formal-methods work on SQL-with-NULLs repeatedly highlights that NULL introduces semantic corner cases that break naïve equalities and make reasoning substantially harder than in classic two-valued relational algebra. 

A few threads are particularly relevant to “query-level nullability inference”:

Formal semantics efforts (e.g., mechanised semantics in proof assistants) treat NULL, three-valued logic, subqueries, joins, and bags as first-class, because many equivalences that hold without NULL are unsound with NULL. 
Work on “certain answers” and correctness with nulls shows that even foundational questions like “what does this query mean under incomplete information?” can be complex, and tractability depends heavily on the SQL fragment considered. 
Recent SMT-based verification tools (e.g., VeriEQL) encode integrity constraints such as NotNull(R, a) explicitly and reason about them during equivalence checking; this underscores that nullability is often best modelled as a constraint problem rather than a simple type annotation. 
Even when you treat NULL as a value (rather than a separate type), the key operational complexity comes from SQL’s three-valued boolean semantics in WHERE-like filters and from operator/function “NULL intolerance” (strictness) vs special non-strict operators such as IS DISTINCT FROM/boolean connectives—exactly the cases PostgreSQL’s planner code distinguishes. 
This literature aligns with the “core tension” you described: fully precise nullability of arbitrary SELECT expressions would require complete semantics of all functions/operators/predicates in scope, plus correct handling of SQL’s control-flow-like evaluation model (three-valued logic, subquery cardinalities, and join null-extension). 

That is precisely why production systems like PostgreSQL focus on sound, optimisation-relevant nullability reasoning (join reduction, strictness-based inference), not on exposing a general “nullable/non-nullable” proof for every projection expression. 
