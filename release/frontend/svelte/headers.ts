/**
 * TEMPORARY: the problem a file is an answer to.
 *
 * The workspace holds programs; it does not hold what the person was asked to
 * write. Until that lives somewhere real -- assignment metadata, a manifest
 * beside the file, whatever the course tool ends up handing us -- it lives
 * here, keyed by the name of the file the student opens.
 *
 * Keyed by NAME rather than path, and matched without regard for case, so the
 * same table answers for a file wherever it sits in a workspace and whichever
 * way its name was typed. The consequence is the obvious one: two files with
 * the same name in different folders get the same header, which is a trade
 * this table is small enough to be worth.
 *
 * The text is markdown -- it is rendered by the same renderer the tutor's
 * answers go through, so lists, emphasis and code blocks all draw the way
 * they do in the assistant panel.
 */
import { nameOf } from "./paths";

export const headers: Record<string, string> = {
  "demo.py": `Write a program to display "hello world" twice.`,

  "Test.py": `Print "Hello World" and the result of 2+3.`,

  "Welcome.py": `Display three messages`,

  "ComputeExp.py": `Calculate the result of (10.5 + 2 * 3) / (45 - 3.5)`,

  "ex1.3.py": `
**Task 1**

Let us try the following examples. Are you given an error, warning or output?

1. In a print statement, what happens if you leave out one of the parentheses,
   or both?

   \`\`\`python
   print("hello"
   print"hello")
   print"hello"
   \`\`\`

2. If you are trying to print a string, what happens if you leave out one of
   the quotation marks, or both?

   \`\`\`python
   print("hello)
   print(hello")
   print(hello)
   \`\`\`

**Task 2**

Write print statements to calculate and display the results for the following
tasks.

1. How many seconds are there in 42 minutes 42 seconds?

2. How many miles are there in 10 kilometers? *Hint: there are 1.61 kilometers
   in a mile.*

3. If you run a 10 kilometer race in 42 minutes 42 seconds, what is your
   average pace (miles per minute)? What is your average speed in miles per
   hour?
`,
};

const byName = new Map(
  Object.entries(headers).map(([name, text]) => [
    name.toLowerCase(),
    text.trim(),
  ]),
);

/** The problem this file is an answer to, if anybody wrote one down. */
export const headerFor = (path: string): string | undefined =>
  byName.get(nameOf(path).toLowerCase());
