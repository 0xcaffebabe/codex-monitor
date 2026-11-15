export const delegatedInputSql = (item: string) =>
  `lower(replace(json_extract(${item},'$.type'),'_',''))='functioncalloutput'
   AND json_extract(${item},'$.namespace')='codex_app'
   AND json_extract(${item},'$.name') IN ('create_thread','send_message_to_thread')
   AND json_type(${item},'$.output')='text'`;
export const displayItemSql = (item: string) =>
  `CASE WHEN ${delegatedInputSql(item)} THEN ${item}
   ELSE json_remove(${item},'$.aggregatedOutput','$.aggregated_output','$.output','$.result','$.stdout','$.stderr','$.results','$.encrypted_content') END`;
