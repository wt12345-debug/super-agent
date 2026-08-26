import { jsonSchema } from "ai";

export const weatherTool = {
    description:'查询指定城市的天气信息',
    inputSchema:jsonSchema({
        type:'object',
        properties:{
            city:{
                type:'string',
                description:'城市名称，比如："南昌"，"北京"等',
            }
        },
        required:['city'],
        additionalProperties:false,
    }),
    execute:async ({city}:{city:string}) =>{
        const mockWeather:Record<string,any> = {
            '南昌':'晴朗,温度22摄氏度,天气晴',
            '北京':'阴,温度20摄氏度,天气阴',
            '上海':'晴,温度25摄氏度,天气晴',
        }
        return mockWeather[city] || `未找到${city}城市的天气信息`
    }
}
// ai这个SDK包的jsonSchema函数会将inputSchema转换为模型需要的json格式
// {
//   "type": "function",
//   "function": {
//     "name": "get_weather",
//     "description": "查询指定城市的天气信息",
//     "parameters": {
//       "type": "object",
//       "properties": {
//         "city": { "type": "string", "description": "城市名称" }
//       },
//       "required": ["city"]
//     }
//   }
// }