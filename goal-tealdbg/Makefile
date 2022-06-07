SANDBOX= # Path to sandbox
ACCOUNT= # Account to use to create and call app
APP_ID= # ID of app

accounts:
	${SANDBOX} goal account list

create:
	${SANDBOX} copyTo ./program.teal
	${SANDBOX} goal app create \
		--creator ${ACCOUNT} \
		--global-byteslices 3 \
		--global-ints 0 \
		--local-byteslices 0 \
		--local-ints 0 \
		--approval-prog program.teal \
		--clear-prog program.teal

debug:
	${SANDBOX} goal app call --app-id ${APP_ID} --from ${ACCOUNT} --out ./unsigned.tx
	${SANDBOX} goal clerk sign -i unsigned.tx -o signed.tx
	${SANDBOX} goal clerk dryrun -t signed.tx --dryrun-dump -o dr.msgp
	${SANDBOX} tealdbg debug program.teal -d dr.msgp --listen 0.0.0.0
