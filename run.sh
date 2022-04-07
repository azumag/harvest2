while true; do
	symbol='BTC/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='XRP/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='BAT/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='BCH/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='ETH/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='LINK/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='LTC/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='MONA/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='MKR/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='OMG/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='QTUM/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='XLM/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='XYM/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='BOBA/JPY' apikey=$(cat bitbank_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitbank_secret) node functions/bb.js
	symbol='BTC/JPY' exchangeId="bitflyer" apikey=$(cat bitflyer_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitflyer_secret) node functions/bb.js
	symbol='XRP/JPY' exchangeId="bitflyer" apikey=$(cat bitflyer_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitflyer_secret) node functions/bb.js
	symbol='ETH/JPY' exchangeId="bitflyer" apikey=$(cat bitflyer_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitflyer_secret) node functions/bb.js
	symbol='XLM/JPY' exchangeId="bitflyer" apikey=$(cat bitflyer_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitflyer_secret) node functions/bb.js
	symbol='MONA/JPY' exchangeId="bitflyer" apikey=$(cat bitflyer_apikey) slack=https://hooks.slack.com/services/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  secret=$(cat bitflyer_secret) node functions/bb.js
	sleep 600
done &
while true; do 
	slack=https://hooks.slack.com/services/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 interval=day node functions/benefitReport.js 
  sleep 36000 
done &
while true; do 
	slack=https://hooks.slack.com/services/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 interval=week node functions/benefitReport.js
  sleep 252000
done &
while true; do
	slack=https://hooks.slack.com/services/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 interval=month node functions/benefitReport.js
  sleep 360000
done
