- A block that other blocks point at: the importer reads one sheet per floor.
  id:: 0088f1a0-0000-4000-8000-000000000002
- A plain ref to it: ((0088f1a0-0000-4000-8000-000000000002))
  id:: 0088f1a0-0000-4000-8000-000000000003
- A ref to a block on another page: ((0088f1a0-0000-4000-8000-000000000001))
- A ref to a ref, two levels: ((0088f1a0-0000-4000-8000-000000000003))
  id:: 0088f1a0-0000-4000-8000-000000000004
- A ref three levels deep, past the default depth of 2: ((0088f1a0-0000-4000-8000-000000000004))
- Two siblings that point at the same block
	- First sibling: ((0088f1a0-0000-4000-8000-000000000002))
	- Second sibling: ((0088f1a0-0000-4000-8000-000000000002))
- A block embed:
  {{embed ((0088f1a0-0000-4000-8000-000000000002))}}
- A page embed:
  {{embed [[Bob]]}}
- Ref cycle, first half: ping ((0088f1a0-0000-4000-8000-000000000011))
  id:: 0088f1a0-0000-4000-8000-000000000010
- Ref cycle, second half: pong ((0088f1a0-0000-4000-8000-000000000010))
  id:: 0088f1a0-0000-4000-8000-000000000011
- Embed cycle, first half:
  id:: 0088f1a0-0000-4000-8000-000000000020
  {{embed ((0088f1a0-0000-4000-8000-000000000021))}}
- Embed cycle, second half:
  id:: 0088f1a0-0000-4000-8000-000000000021
  {{embed ((0088f1a0-0000-4000-8000-000000000020))}}
- A ref to a block that does not exist: ((0088f1a0-0000-4000-8000-00000000dead))
- An embed of a block that does not exist: {{embed ((0088f1a0-0000-4000-8000-00000000beef))}}
