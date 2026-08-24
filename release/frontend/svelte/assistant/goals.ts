/**
 * What each exercise is for, by the name of its file.
 *
 * HARD-CODED, AND THAT IS TEMPORARY. The progress rule has to compare a
 * program against something, and until an assignment is a thing the server
 * knows about, the only handle anybody has on "what is this student trying to
 * do" is the filename. Written down here rather than in the backend on
 * purpose: the endpoint takes a goal and judges against it, which keeps course
 * content out of a server that should not need redeploying when a term's
 * exercises change.
 *
 * Matched on the file's NAME and not its path, because the same exercise
 * arrives in a folder or at the root depending on how a student made it.
 */
export const GOALS: Readonly<Record<string, string>> = {
  "demo.py": 'Write a program to display "hello world" twice.',
  "Test.py": 'Print "Hello World" and the result of 2+3.',
  "Welcome.py": "Display three messages.",
  "ComputeExp.py": "Calculate the result of (10.5 + 2 * 3) / (45 - 3.5).",
  "ex1.3.py": `Task 1:
Let us try following examples. Are you given an error, warning or output?
1) In a print statement, what happens if you leave out one of the
parentheses, or both?
print("hello"
print"hello")
print"hello"
2) If you are trying to print a string, what happens if you leave out one of
the quotation marks, or both?
print("hello)
print(hello")
print(hello)

Task 2:
Write print statements to calculate and display the results for following tasks.
1) How many seconds are there in 42 minutes 42 seconds?

2) How many miles are there in 10 kilometers? Hint: there are 1.61 kilometers
in a mile.

3) If you run a 10 kilometer race in 42 minutes 42 seconds, what is your
average pace (miles per minutes)? What is your average speed in miles per
hour?`,
};

/** The goal for a path, if anybody has written one down for its name. */
export const goalOf = (path: string): string | undefined =>
  GOALS[path.split("/").pop() ?? path];
