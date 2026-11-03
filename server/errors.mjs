export class Problem extends Error {
  constructor(status,message,field,code){super(message);this.status=status;this.field=field;this.code=code}
}
