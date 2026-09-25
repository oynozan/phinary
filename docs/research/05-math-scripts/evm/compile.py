import solcx, json
out = solcx.compile_files(['src/T.sol'], output_values=['abi','bin-runtime'], solc_version='0.8.26',
  import_remappings=['solstat/=/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/repos/solstat/src/','solady/=/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/repos/solady/src/','solmate/=/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/fc05/solmate/src/'], optimize=True, optimize_runs=200, allow_paths=['/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/repos','/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/fc05'])
k=[k for k in out if k.endswith(':T')][0]
json.dump({'abi':out[k]['abi'],'bin':out[k]['bin-runtime']}, open('T.json','w'))
print('ok', len(out[k]['bin-runtime'])//2)
