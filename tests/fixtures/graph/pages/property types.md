type:: reference
category:: [[test data]]
created-by:: Alice

- This page holds test data for query_by_property: one block per property value type.
- A text value
  status:: testing
- A whole number and a decimal
  effort:: 3
  ratio:: 0.75
- Booleans, true and false
  reviewed:: true
  archived:: false
- One page ref, a one-element set
  owner:: [[Alice]]
- Two page refs, a multi-value set
  participants:: [[Alice]], [[Bob]]
- Comma-separated plain values, split because config.edn lists reviewers
  reviewers:: Bob, Carol
- Commas in a property that config.edn does not list stay one text value
  summary:: ships after review, then Alice and Bob sign off
- A dashed key, which the Editor API returns camelCased
  created-by:: Bob
  due-date:: [[Jan 15th, 2025]]
- A tag as a value, and a URL
  topic:: #planning
  link:: https://example.com/atlas
